package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lord007tn/jood-monitor/internal/agentutil"
	"github.com/lord007tn/jood-monitor/internal/contracts"
	collector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/proto"
	authentication "k8s.io/api/authentication/v1"
	core "k8s.io/api/core/v1"
	quantity "k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	podresources "k8s.io/component-helpers/resource"
)

type observer struct {
	client              kubernetes.Interface
	dynamic             dynamic.Interface
	spool               *spool
	mu                  sync.RWMutex
	profile             contracts.Profile
	nodeLast            map[string]time.Time
	nodeAcknowledgments map[string]contracts.NodeAcknowledgment
	seen                map[string]bool
	dirty               chan struct{}
}

func runObserver(ctx context.Context) error {
	hub := os.Getenv("JOOD_HUB_URL")
	if !strings.HasPrefix(hub, "https://") {
		return errors.New("HTTPS hub URL required")
	}
	maximum, err := spoolMaximumBytes(os.Getenv("JOOD_SPOOL_MAX_BYTES"))
	if err != nil {
		return err
	}
	config, err := rest.InClusterConfig()
	if err != nil {
		return errors.New("kubernetes in-cluster configuration required")
	}
	config.QPS = 5
	config.Burst = 10
	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		return err
	}
	dyn, err := dynamic.NewForConfig(config)
	if err != nil {
		return err
	}
	httpClient, err := secureClient("")
	if err != nil {
		return err
	}
	dir := env("JOOD_SPOOL_DIR", "/var/spool/jood")
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	sp := &spool{dir: dir, max: maximum, client: httpClient, hub: hub, credentialFile: os.Getenv("JOOD_CREDENTIAL_FILE")}
	o := &observer{client: client, dynamic: dyn, spool: sp, profile: contracts.Profile{Name: "basic", Revision: 1}, nodeLast: map[string]time.Time{}, nodeAcknowledgments: map[string]contracts.NodeAcknowledgment{}, seen: map[string]bool{}, dirty: make(chan struct{}, 1)}
	mux := http.NewServeMux()
	mux.HandleFunc("/node/v1/collect", o.collectNode)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	server := &http.Server{Addr: env("JOOD_LISTEN", ":8081"), Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(c)
	}()
	go o.loop(ctx)
	o.startWatches(ctx)
	cert, key := os.Getenv("JOOD_TLS_CERT_FILE"), os.Getenv("JOOD_TLS_KEY_FILE")
	if cert == "" || key == "" {
		return errors.New("observer TLS certificate and key required")
	}
	err = server.ListenAndServeTLS(cert, key)
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
func (o *observer) loop(ctx context.Context) {
	origin := time.Now()
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	var inventorySchedule, resourceSchedule sampleSchedule
	for {
		requestCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		p, err := readProfile(requestCtx, o.spool.client, o.spool.hub+"/machine/v1/profile", o.spool.credentialFile)
		o.mu.Lock()
		if err == nil {
			o.profile = p
		}
		p = o.profile
		if p.Name == "diagnostic" && (p.ExpiresAt == nil || time.Now().After(*p.ExpiresAt)) {
			p.Name = returnProfile(p)
			o.profile = p
		}
		o.mu.Unlock()
		capabilities := []string{"inventory", "host_proc", "token_review"}
		dirty := false
		select {
		case <-o.dirty:
			dirty = true
		default:
		}
		if dirty || inventorySchedule.due(time.Now(), 60*time.Second) {
			inventory, e := o.inventory(requestCtx)
			if e == nil {
				inventorySchedule.collected(time.Now(), origin, 60*time.Second)
				o.spool.deliver(requestCtx, "/machine/v1/inventory", "PUT", "application/json", []byte(agentutil.JSON(inventory)))
			} else {
				capabilities = append(capabilities, "inventory_unavailable")
			}
		}
		interval := resourceSampleInterval(p)
		if !p.Paused && resourceSchedule.due(time.Now(), interval) {
			pods := p.Name != "basic"
			b, e := o.resourceMetrics(requestCtx, pods, p)
			if e == nil {
				resourceSchedule.collected(time.Now(), origin, interval)
				o.spool.deliver(requestCtx, "/v1/metrics", "POST", "application/x-protobuf", b)
				capabilities = append(capabilities, "metrics_api")
			} else {
				capabilities = append(capabilities, "metrics_api_unavailable")
			}
		}
		bytes, drops := o.spool.stats()
		hb := contracts.Heartbeat{Version: version, AppliedRevision: p.Revision, QueueBytes: bytes, Dropped: drops, RejectedPoints: o.spool.rejectedPoints(), Capabilities: capabilities, Outcome: "observer applied", Nodes: o.acknowledgments()}
		o.spool.deliver(requestCtx, "/machine/v1/heartbeat", "POST", "application/json", []byte(agentutil.JSON(hb)))
		o.spool.flush(requestCtx)
		cancel()
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
func (o *observer) collectNode(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if len(token) > 16384 {
		w.WriteHeader(401)
		return
	}
	review, err := o.client.AuthenticationV1().TokenReviews().Create(ctx, &authentication.TokenReview{Spec: authentication.TokenReviewSpec{Token: token, Audiences: []string{"jood-monitor-node"}}}, metav1.CreateOptions{})
	if err != nil || !review.Status.Authenticated || review.Status.Error != "" {
		w.WriteHeader(401)
		return
	}
	audience := false
	for _, a := range review.Status.Audiences {
		if a == "jood-monitor-node" {
			audience = true
		}
	}
	if !audience {
		w.WriteHeader(401)
		return
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		w.WriteHeader(401)
		return
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		w.WriteHeader(401)
		return
	}
	var claims struct {
		Kubernetes struct {
			Namespace string `json:"namespace"`
			Pod       struct {
				Name string `json:"name"`
				UID  string `json:"uid"`
			} `json:"pod"`
			ServiceAccount struct {
				Name string `json:"name"`
				UID  string `json:"uid"`
			} `json:"serviceaccount"`
		} `json:"kubernetes.io"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		w.WriteHeader(401)
		return
	}
	k := claims.Kubernetes
	namespace := env("JOOD_NAMESPACE", "jood-monitor")
	sa := env("JOOD_NODE_SERVICE_ACCOUNT", "jood-monitor-node")
	if k.Namespace != namespace || k.ServiceAccount.Name != sa || review.Status.User.Username != "system:serviceaccount:"+namespace+":"+sa {
		w.WriteHeader(403)
		return
	}
	pod, err := o.client.CoreV1().Pods(namespace).Get(ctx, k.Pod.Name, metav1.GetOptions{})
	if err != nil || pod.UID != types.UID(k.Pod.UID) || pod.Spec.ServiceAccountName != sa || pod.DeletionTimestamp != nil {
		w.WriteHeader(403)
		return
	}
	node, err := o.client.CoreV1().Nodes().Get(ctx, pod.Spec.NodeName, metav1.GetOptions{})
	if err != nil {
		w.WriteHeader(403)
		return
	}
	var in nodeBatch
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10))
	dec.DisallowUnknownFields()
	if dec.Decode(&in) != nil || in.NodeName != node.Name || len(in.Points) > 512 || in.SourceTime.After(time.Now().Add(time.Minute)) || in.SourceTime.Before(time.Now().Add(-5*time.Minute)) {
		w.WriteHeader(400)
		return
	}
	o.mu.Lock()
	p := o.profile
	last := o.nodeLast[string(node.UID)]
	if time.Since(last) < 4*time.Second {
		o.mu.Unlock()
		w.Header().Set("Retry-After", "4")
		w.WriteHeader(429)
		return
	}
	o.nodeLast[string(node.UID)] = time.Now()
	if o.nodeAcknowledgments == nil {
		o.nodeAcknowledgments = map[string]contracts.NodeAcknowledgment{}
	}
	o.nodeAcknowledgments[string(node.UID)] = contracts.NodeAcknowledgment{NodeUID: string(node.UID), SeenAt: time.Now().UTC(), AppliedRevision: in.AppliedRevision, Profile: in.AppliedProfile, Paused: in.Paused, Dropped: in.Dropped}
	o.mu.Unlock()
	if p.Name == "diagnostic" {
		selected := false
		for _, uid := range p.NodeUIDs {
			if uid == string(node.UID) {
				selected = true
			}
		}
		if !selected || p.ExpiresAt == nil || time.Now().After(*p.ExpiresAt) {
			p.Name = returnProfile(p)
			p.ExpiresAt = nil
		}
	}
	// Pause stops new sampling; previously collected buffered data can drain.
	if len(in.Points) > 0 {
		o.spool.deliver(ctx, "/v1/metrics", "POST", "application/x-protobuf", hostOTLP(in, string(node.UID)))
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(nodeResponse{NodeUID: string(node.UID), Profile: p})
}

func (o *observer) acknowledgments() []contracts.NodeAcknowledgment {
	o.mu.RLock()
	defer o.mu.RUnlock()
	result := []contracts.NodeAcknowledgment{}
	for _, ack := range o.nodeAcknowledgments {
		result = append(result, ack)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].NodeUID < result[j].NodeUID })
	return result
}
func f(v float64) *float64 { return &v }
func (o *observer) inventory(ctx context.Context) (contracts.Inventory, error) {
	out := contracts.Inventory{SourceTime: time.Now().UTC(), Entities: []contracts.Entity{}, Edges: []contracts.Edge{}, Capabilities: []string{"inventory"}}
	nodes, err := o.client.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return out, err
	}
	nodeUID := map[string]string{}
	for _, n := range nodes.Items {
		status := "Unknown"
		for _, c := range n.Status.Conditions {
			if c.Type == core.NodeReady {
				status = string(c.Status)
			}
		}
		nodeUID[n.Name] = string(n.UID)
		entity := contracts.Entity{UID: string(n.UID), Kind: "Node", Name: n.Name, Status: status, ProviderID: n.Spec.ProviderID, CapacityCPU: f(float64(n.Status.Capacity.Cpu().MilliValue()) / 1000), AllocatableCPU: f(float64(n.Status.Allocatable.Cpu().MilliValue()) / 1000), CapacityMemory: f(float64(n.Status.Capacity.Memory().Value())), AllocatableMemory: f(float64(n.Status.Allocatable.Memory().Value()))}
		nodeDetails(&entity, n)
		out.Entities = append(out.Entities, entity)
	}
	pods, err := o.client.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return out, err
	}
	uids := map[string]bool{}
	for _, e := range out.Entities {
		uids[e.UID] = true
	}
	for _, p := range pods.Items {
		e := contracts.Entity{UID: string(p.UID), Kind: "Pod", Name: p.Name, Namespace: p.Namespace, NodeUID: nodeUID[p.Spec.NodeName], Status: string(p.Status.Phase)}
		podDetails(&e, p)
		requests := podresources.PodRequests(&p, podresources.PodResourcesOptions{})
		limits := podresources.PodLimits(&p, podresources.PodResourcesOptions{})
		e.RequestedCPU = f(requests.Cpu().AsApproximateFloat64())
		e.RequestedMemory = f(float64(requests.Memory().Value()))
		if cpu, ok := limits[core.ResourceCPU]; ok {
			e.LimitedCPU = f(cpu.AsApproximateFloat64())
		}
		if memory, ok := limits[core.ResourceMemory]; ok {
			e.LimitedMemory = f(float64(memory.Value()))
		}
		for _, c := range p.Status.ContainerStatuses {
			e.Restarts += c.RestartCount
			if c.LastTerminationState.Terminated != nil && c.LastTerminationState.Terminated.Reason == "OOMKilled" {
				e.Status += " / OOM observed"
			}
		}
		e.Containers = containerStates(p.Status.ContainerStatuses, false)
		e.Containers = append(e.Containers, containerStates(p.Status.InitContainerStatuses, true)...)
		for _, condition := range p.Status.Conditions {
			if condition.Type == core.PodResizePending || condition.Type == core.PodResizeInProgress {
				e.ResizeConditions = append(e.ResizeConditions, contracts.ResizeCondition{Type: string(condition.Type), Status: string(condition.Status), Reason: condition.Reason, TransitionTime: condition.LastTransitionTime.Time})
			}
		}
		out.Entities = append(out.Entities, e)
		uids[e.UID] = true
		if e.NodeUID != "" {
			out.Edges = append(out.Edges, contracts.Edge{Source: e.UID, Target: e.NodeUID, Relation: "scheduled_on", Evidence: "Pod.spec.nodeName"})
		}
	}
	workloads := []schema.GroupVersionResource{{Group: "apps", Version: "v1", Resource: "deployments"}, {Group: "apps", Version: "v1", Resource: "replicasets"}, {Group: "apps", Version: "v1", Resource: "statefulsets"}, {Group: "apps", Version: "v1", Resource: "daemonsets"}, {Group: "autoscaling", Version: "v2", Resource: "horizontalpodautoscalers"}, {Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"}, {Group: "", Version: "v1", Resource: "services"}, {Group: "", Version: "v1", Resource: "persistentvolumeclaims"}, {Group: "", Version: "v1", Resource: "persistentvolumes"}, {Group: "", Version: "v1", Resource: "namespaces"}, {Group: "autoscaling.k8s.io", Version: "v1", Resource: "verticalpodautoscalers"}}
	workloads = append(workloads, schema.GroupVersionResource{Group: "discovery.k8s.io", Version: "v1", Resource: "endpointslices"})
	objects := []unstructured.Unstructured{}
	for _, gvr := range workloads {
		list, e := o.dynamic.Resource(gvr).Namespace("").List(ctx, metav1.ListOptions{})
		if e != nil {
			out.Capabilities = append(out.Capabilities, gvr.Resource+"_unavailable")
			continue
		}
		for _, obj := range list.Items {
			objects = append(objects, obj)
			entity := contracts.Entity{UID: string(obj.GetUID()), Kind: obj.GetKind(), Name: obj.GetName(), Namespace: obj.GetNamespace(), Status: "Observed"}
			if spec, ok := obj.Object["spec"].(map[string]any); ok {
				if template, ok := spec["template"]; ok {
					raw, _ := json.Marshal(template)
					var pt core.PodTemplateSpec
					if json.Unmarshal(raw, &pt) == nil {
						pod := core.Pod{Spec: pt.Spec}
						requests := podresources.PodRequests(&pod, podresources.PodResourcesOptions{})
						limits := podresources.PodLimits(&pod, podresources.PodResourcesOptions{})
						entity.RequestedCPU = f(requests.Cpu().AsApproximateFloat64())
						entity.RequestedMemory = f(float64(requests.Memory().Value()))
						if cpu, ok := limits[core.ResourceCPU]; ok {
							entity.LimitedCPU = f(cpu.AsApproximateFloat64())
						}
						if memory, ok := limits[core.ResourceMemory]; ok {
							entity.LimitedMemory = f(float64(memory.Value()))
						}
					}
				}
				if n, ok := spec["replicas"].(int64); ok {
					x := int32(n)
					entity.Desired = &x
				}
			}
			if status, ok := obj.Object["status"].(map[string]any); ok {
				if n, ok := status["desiredReplicas"].(int64); ok {
					x := int32(n)
					entity.Desired = &x
				}
				if n, ok := status["readyReplicas"].(int64); ok {
					x := int32(n)
					entity.Ready = &x
				}
			}
			objectDetails(&entity, obj)
			uids[entity.UID] = true
			out.Entities = append(out.Entities, entity)
			for _, owner := range obj.GetOwnerReferences() {
				out.Edges = append(out.Edges, contracts.Edge{Source: entity.UID, Target: string(owner.UID), Relation: "owned_by", Evidence: "metadata.ownerReferences"})
			}
		}
	}
	for _, p := range pods.Items {
		for _, owner := range p.OwnerReferences {
			out.Edges = append(out.Edges, contracts.Edge{Source: string(p.UID), Target: string(owner.UID), Relation: "owned_by", Evidence: "metadata.ownerReferences"})
		}
	}
	services, err := o.client.CoreV1().Services("").List(ctx, metav1.ListOptions{})
	if err == nil {
		for _, svc := range services.Items {
			if len(svc.Spec.Selector) == 0 {
				continue
			}
			for _, p := range pods.Items {
				if p.Namespace != svc.Namespace {
					continue
				}
				match := true
				for k, v := range svc.Spec.Selector {
					if p.Labels[k] != v {
						match = false
					}
				}
				if match {
					out.Edges = append(out.Edges, contracts.Edge{Source: string(svc.UID), Target: string(p.UID), Relation: "selects", Evidence: "Service.spec.selector; configuration only"})
				}
			}
		}
	}
	addRelations(&out, pods.Items, objects)
	edges := []contracts.Edge{}
	for _, e := range out.Edges {
		if uids[e.Source] && uids[e.Target] {
			edges = append(edges, e)
		}
	}
	out.Edges = edges
	return out, nil
}

func containerStates(statuses []core.ContainerStatus, init bool) []contracts.ContainerState {
	out := []contracts.ContainerState{}
	for _, status := range statuses {
		state := contracts.ContainerState{Name: status.Name, Init: init}
		if status.Resources != nil {
			if cpu, ok := status.Resources.Requests[core.ResourceCPU]; ok {
				state.AppliedCPU = f(cpu.AsApproximateFloat64())
			}
			if memory, ok := status.Resources.Requests[core.ResourceMemory]; ok {
				state.AppliedMemory = f(float64(memory.Value()))
			}
		}
		if cpu, ok := status.AllocatedResources[core.ResourceCPU]; ok {
			state.AllocatedCPU = f(cpu.AsApproximateFloat64())
		}
		if memory, ok := status.AllocatedResources[core.ResourceMemory]; ok {
			state.AllocatedMemory = f(float64(memory.Value()))
		}
		out = append(out, state)
	}
	return out
}

type metricList struct {
	Items []struct {
		Metadata   struct{ Name, Namespace string }
		Timestamp  time.Time
		Window     string
		Usage      map[string]string
		Containers []struct {
			Name  string
			Usage map[string]string
		}
	}
}

func (o *observer) resourceMetrics(ctx context.Context, pods bool, profile contracts.Profile) ([]byte, error) {
	req := &collector.ExportMetricsServiceRequest{}
	inventory, err := o.client.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	nodes := map[string]string{}
	for _, n := range inventory.Items {
		nodes[n.Name] = string(n.UID)
	}
	raw, err := o.client.CoreV1().RESTClient().Get().AbsPath("/apis/metrics.k8s.io/v1beta1/nodes").Do(ctx).Raw()
	if err != nil {
		return nil, err
	}
	var list metricList
	if json.Unmarshal(raw, &list) != nil {
		return nil, errors.New("invalid metrics source")
	}
	for _, item := range list.Items {
		uid := nodes[item.Metadata.Name]
		if uid != "" {
			rm := usageMetrics(uid, "Node", item.Timestamp, item.Window, item.Usage, "")
			rm.Resource.Attributes = append(rm.Resource.Attributes, kv("jood.collection.profile", effectiveNodeProfile(profile, uid)))
			req.ResourceMetrics = append(req.ResourceMetrics, rm)
		}
	}
	if pods {
		podList, e := o.client.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
		if e != nil {
			return nil, e
		}
		ids := map[string]string{}
		podNodes := map[string]string{}
		for _, p := range podList.Items {
			ids[p.Namespace+"/"+p.Name] = string(p.UID)
			podNodes[string(p.UID)] = nodes[p.Spec.NodeName]
		}
		raw, e := o.client.CoreV1().RESTClient().Get().AbsPath("/apis/metrics.k8s.io/v1beta1/pods").Do(ctx).Raw()
		if e != nil {
			return nil, e
		}
		var list metricList
		if json.Unmarshal(raw, &list) != nil {
			return nil, errors.New("invalid pod metrics source")
		}
		for _, item := range list.Items {
			allowed := len(profile.Namespaces) == 0
			for _, n := range profile.Namespaces {
				if n == item.Metadata.Namespace {
					allowed = true
				}
			}
			if !allowed {
				continue
			}
			uid := ids[item.Metadata.Namespace+"/"+item.Metadata.Name]
			if uid == "" {
				continue
			}
			totals := map[string]quantity.Quantity{}
			valid := map[string]bool{"cpu": len(item.Containers) > 0, "memory": len(item.Containers) > 0}
			for _, container := range item.Containers {
				req.ResourceMetrics = append(req.ResourceMetrics, usageMetrics(uid, "Pod", item.Timestamp, item.Window, container.Usage, container.Name))
				for _, field := range []string{"cpu", "memory"} {
					q, err := quantity.ParseQuantity(container.Usage[field])
					if err != nil {
						valid[field] = false
						continue
					}
					total := totals[field]
					total.Add(q)
					totals[field] = total
				}
			}
			usage := map[string]string{}
			for field, total := range totals {
				if valid[field] {
					usage[field] = total.String()
				}
			}
			req.ResourceMetrics = append(req.ResourceMetrics, usageMetrics(uid, "Pod", item.Timestamp, item.Window, usage, ""))
		}
		for _, rm := range req.ResourceMetrics {
			uid := attrValue(rm.Resource.Attributes, "k8s.pod.uid")
			if uid != "" {
				rm.Resource.Attributes = append(rm.Resource.Attributes, kv("jood.collection.profile", effectiveNodeProfile(profile, podNodes[uid])))
			}
		}
	}
	return proto.Marshal(req)
}

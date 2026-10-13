package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/lord007tn/jood-monitor/internal/contracts"
	core "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestPodReadinessDoesNotUseRunningOrContainersReady(t *testing.T) {
	pod := core.Pod{Status: core.PodStatus{Phase: core.PodRunning, Conditions: []core.PodCondition{{Type: core.ContainersReady, Status: core.ConditionTrue}, {Type: core.PodReady, Status: core.ConditionFalse}}}}
	entity := contracts.Entity{Kind: "Pod", Status: "Running"}
	podDetails(&entity, pod)
	if entity.Ready == nil || *entity.Ready != 0 || *entity.Desired != 1 {
		t.Fatal("Running with unfulfilled readiness gates must not be Ready")
	}
	pod.Status.Conditions[1].Status = core.ConditionTrue
	podDetails(&entity, pod)
	if *entity.Ready != 1 {
		t.Fatal("explicit PodReady condition was lost")
	}
	pod.Status.ContainerStatuses = []core.ContainerStatus{{State: core.ContainerState{Waiting: &core.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}}}
	podDetails(&entity, pod)
	if entity.Status != "CrashLoopBackOff" {
		t.Fatal("waiting cause was hidden")
	}
}

func TestControllerReadinessDoesNotUseCurrentReplicas(t *testing.T) {
	for _, kind := range []string{"Deployment", "StatefulSet", "ReplicaSet"} {
		entity := contracts.Entity{Kind: kind}
		object := unstructured.Unstructured{Object: map[string]any{"status": map[string]any{"currentReplicas": int64(5), "replicas": int64(5)}}}
		objectDetails(&entity, object)
		if entity.Ready == nil || *entity.Ready != 0 {
			t.Fatalf("%s invented ready replicas", kind)
		}
		object.Object["status"].(map[string]any)["readyReplicas"] = int64(3)
		objectDetails(&entity, object)
		if *entity.Ready != 3 {
			t.Fatalf("%s did not use readyReplicas", kind)
		}
	}
	entity := contracts.Entity{Kind: "DaemonSet"}
	objectDetails(&entity, unstructured.Unstructured{Object: map[string]any{"status": map[string]any{"numberReady": int64(2), "desiredNumberScheduled": int64(4)}}})
	if *entity.Ready != 2 || *entity.Desired != 4 {
		t.Fatal("DaemonSet must use its scheduled readiness counters")
	}
}

func TestInventoryMetadataAllowsOnlySelectedFields(t *testing.T) {
	node := core.Node{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"node-role.kubernetes.io/worker": "", "topology.kubernetes.io/zone": "test-zone", "private-test": "DO_NOT_EXPORT"}, Annotations: map[string]string{"private-test": "DO_NOT_EXPORT"}}, Status: core.NodeStatus{Addresses: []core.NodeAddress{{Type: core.NodeInternalIP, Address: "10.0.0.1"}, {Type: core.NodeExternalIP, Address: "203.0.113.1"}}, NodeInfo: core.NodeSystemInfo{OSImage: "Test OS", KernelVersion: "test-kernel", KubeletVersion: "test-version"}}}
	entity := contracts.Entity{Kind: "Node"}
	nodeDetails(&entity, node)
	if len(entity.Addresses) != 1 || entity.Addresses[0] != "10.0.0.1" || entity.Zone != "test-zone" || len(entity.Roles) != 1 {
		t.Fatal("selected node identity missing")
	}
	raw, _ := json.Marshal(entity)
	if strings.Contains(string(raw), "DO_NOT_EXPORT") || strings.Contains(string(raw), "203.0.113.1") {
		t.Fatal("unselected node metadata escaped")
	}
	service := contracts.Entity{Kind: "Service"}
	objectDetails(&service, unstructured.Unstructured{Object: map[string]any{"spec": map[string]any{"type": "ClusterIP", "clusterIPs": []any{"None", "10.43.0.1"}, "ports": []any{map[string]any{"name": "http", "port": int64(8080), "protocol": "TCP"}}, "private-test": "DO_NOT_EXPORT"}}})
	if service.ServiceType != "ClusterIP" || len(service.Addresses) != 1 || service.Ports[0].Port != 8080 {
		t.Fatal("service identity missing")
	}
	raw, _ = json.Marshal(service)
	if strings.Contains(string(raw), "DO_NOT_EXPORT") {
		t.Fatal("raw service spec escaped")
	}
}

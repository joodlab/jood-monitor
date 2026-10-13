package main

import (
	"sort"
	"strings"

	"github.com/lord007tn/jood-monitor/internal/contracts"
	core "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Only explicitly selected status/identity fields leave the cluster. Never include
// raw objects, pod templates, environment variables, ConfigMap or Secret values.
func nodeDetails(entity *contracts.Entity, node core.Node) {
	created := node.CreationTimestamp.Time
	entity.CreatedAt = &created
	entity.Region = node.Labels["topology.kubernetes.io/region"]
	entity.Zone = node.Labels["topology.kubernetes.io/zone"]
	entity.OS = node.Status.NodeInfo.OSImage
	entity.Kernel = node.Status.NodeInfo.KernelVersion
	entity.KubeletVersion = node.Status.NodeInfo.KubeletVersion
	for key := range node.Labels {
		if strings.HasPrefix(key, "node-role.kubernetes.io/") {
			entity.Roles = append(entity.Roles, strings.TrimPrefix(key, "node-role.kubernetes.io/"))
		}
	}
	sort.Strings(entity.Roles)
	for _, address := range node.Status.Addresses {
		if address.Type == core.NodeInternalIP {
			entity.Addresses = append(entity.Addresses, address.Address)
		}
	}
	for _, condition := range node.Status.Conditions {
		entity.Conditions = append(entity.Conditions, contracts.ObjectCondition{Type: string(condition.Type), Status: string(condition.Status), Reason: condition.Reason})
	}
}

func podDetails(entity *contracts.Entity, pod core.Pod) {
	created := pod.CreationTimestamp.Time
	entity.CreatedAt = &created
	for _, address := range pod.Status.PodIPs {
		entity.Addresses = append(entity.Addresses, address.IP)
	}
	entity.Desired, entity.Ready = int32Pointer(1), int32Pointer(0)
	for _, condition := range pod.Status.Conditions {
		if condition.Type == core.PodReady && condition.Status == core.ConditionTrue {
			entity.Ready = int32Pointer(1)
		}
	}
	// Running is a phase, not readiness. Surface explicit waiting causes separately.
	for _, status := range append(append([]core.ContainerStatus{}, pod.Status.InitContainerStatuses...), pod.Status.ContainerStatuses...) {
		if status.State.Waiting != nil && status.State.Waiting.Reason != "" {
			entity.Status = status.State.Waiting.Reason
			break
		}
	}
}

func int32Pointer(value int32) *int32 { return &value }

func objectDetails(entity *contracts.Entity, object unstructured.Unstructured) {
	created := object.GetCreationTimestamp().Time
	entity.CreatedAt = &created
	switch entity.Kind {
	case "Deployment", "ReplicaSet", "StatefulSet", "DaemonSet":
		// Absent readyReplicas means zero, never currentReplicas or HPA replicas.
		ready, _, _ := unstructured.NestedInt64(object.Object, "status", "readyReplicas")
		if entity.Kind == "DaemonSet" {
			ready, _, _ = unstructured.NestedInt64(object.Object, "status", "numberReady")
			desired, _, _ := unstructured.NestedInt64(object.Object, "status", "desiredNumberScheduled")
			entity.Desired = int32Pointer(int32(desired))
		}
		entity.Ready = int32Pointer(int32(ready))
	case "Service":
		entity.ServiceType, _, _ = unstructured.NestedString(object.Object, "spec", "type")
		addresses, _, _ := unstructured.NestedStringSlice(object.Object, "spec", "clusterIPs")
		for _, address := range addresses {
			if address != "None" {
				entity.Addresses = append(entity.Addresses, address)
			}
		}
		ports, _, _ := unstructured.NestedSlice(object.Object, "spec", "ports")
		for _, port := range ports {
			p, ok := port.(map[string]any)
			if !ok {
				continue
			}
			name, _, _ := unstructured.NestedString(p, "name")
			protocol, _, _ := unstructured.NestedString(p, "protocol")
			value, _, _ := unstructured.NestedInt64(p, "port")
			entity.Ports = append(entity.Ports, contracts.ServicePort{Name: name, Port: int32(value), Protocol: protocol})
		}
	case "Ingress":
		rules, _, _ := unstructured.NestedSlice(object.Object, "spec", "rules")
		for _, rule := range rules {
			if r, ok := rule.(map[string]any); ok {
				host, _, _ := unstructured.NestedString(r, "host")
				if host != "" {
					entity.Hosts = append(entity.Hosts, host)
				}
			}
		}
	}
}

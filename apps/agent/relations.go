package main

import (
	"github.com/lord007tn/jood-monitor/internal/contracts"
	core "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func addRelations(out *contracts.Inventory, pods []core.Pod, objects []unstructured.Unstructured) {
	ids := map[string]string{}
	for _, entity := range out.Entities {
		ids[entity.Kind+"/"+entity.Namespace+"/"+entity.Name] = entity.UID
	}
	edge := func(source, target, relation, evidence string) {
		if source != "" && target != "" {
			out.Edges = append(out.Edges, contracts.Edge{Source: source, Target: target, Relation: relation, Evidence: evidence})
		}
	}
	for _, entity := range out.Entities {
		if entity.Namespace != "" {
			edge(ids["Namespace//"+entity.Namespace], entity.UID, "contains", "metadata.namespace")
		}
	}
	for _, pod := range pods {
		for _, volume := range pod.Spec.Volumes {
			if volume.PersistentVolumeClaim != nil {
				edge(string(pod.UID), ids["PersistentVolumeClaim/"+pod.Namespace+"/"+volume.PersistentVolumeClaim.ClaimName], "uses_volume", "Pod.spec.volumes.persistentVolumeClaim")
			}
		}
	}
	for _, object := range objects {
		uid, namespace := string(object.GetUID()), object.GetNamespace()
		switch object.GetKind() {
		case "HorizontalPodAutoscaler", "VerticalPodAutoscaler":
			ref, ok, _ := unstructured.NestedMap(object.Object, "spec", "scaleTargetRef")
			if object.GetKind() == "VerticalPodAutoscaler" {
				ref, ok, _ = unstructured.NestedMap(object.Object, "spec", "targetRef")
			}
			if ok {
				kind, _ := ref["kind"].(string)
				name, _ := ref["name"].(string)
				edge(ids[kind+"/"+namespace+"/"+name], uid, "autoscaled_by", "spec target reference; policy only")
			}
		case "PersistentVolumeClaim":
			name, _, _ := unstructured.NestedString(object.Object, "spec", "volumeName")
			edge(uid, ids["PersistentVolume//"+name], "bound_to", "PersistentVolumeClaim.spec.volumeName")
		case "Ingress":
			backends := []any{}
			if backend, ok, _ := unstructured.NestedMap(object.Object, "spec", "defaultBackend"); ok {
				backends = append(backends, backend)
			}
			rules, _, _ := unstructured.NestedSlice(object.Object, "spec", "rules")
			for _, rule := range rules {
				r, ok := rule.(map[string]any)
				if !ok {
					continue
				}
				paths, _, _ := unstructured.NestedSlice(r, "http", "paths")
				for _, path := range paths {
					p, ok := path.(map[string]any)
					if ok {
						backends = append(backends, p["backend"])
					}
				}
			}
			for _, backend := range backends {
				b, ok := backend.(map[string]any)
				if !ok {
					continue
				}
				name, _, _ := unstructured.NestedString(b, "service", "name")
				edge(uid, ids["Service/"+namespace+"/"+name], "routes_to", "Ingress backend; configuration only")
			}
		case "EndpointSlice":
			service := ids["Service/"+namespace+"/"+object.GetLabels()["kubernetes.io/service-name"]]
			endpoints, _, _ := unstructured.NestedSlice(object.Object, "endpoints")
			for _, endpoint := range endpoints {
				e, ok := endpoint.(map[string]any)
				if !ok {
					continue
				}
				target, _, _ := unstructured.NestedString(e, "targetRef", "uid")
				edge(service, target, "has_endpoint", "EndpointSlice.targetRef; observed endpoint, not traffic")
			}
		}
	}
}

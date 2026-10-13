package main

import (
	common "go.opentelemetry.io/proto/otlp/common/v1"
	metrics "go.opentelemetry.io/proto/otlp/metrics/v1"
	resource "go.opentelemetry.io/proto/otlp/resource/v1"
	quantity "k8s.io/apimachinery/pkg/api/resource"
	"time"
)

func usageMetrics(uid, kind string, at time.Time, window string, usage map[string]string, container string) *metrics.ResourceMetrics {
	key := "k8s.node.uid"
	cpuName, memName := "k8s.node.cpu.usage", "k8s.node.memory.usage"
	if kind == "Pod" {
		key = "k8s.pod.uid"
		cpuName, memName = "k8s.pod.cpu.usage", "k8s.pod.memory.usage"
		if container != "" {
			cpuName, memName = "container.cpu.usage", "container.memory.usage"
		}
	}
	attrs := []*common.KeyValue{kv(key, uid), kv("jood.source", "metrics.k8s.io"), kv("jood.source.window", window)}
	if container != "" {
		attrs = append(attrs, kv("k8s.container.name", container))
	}
	rm := &metrics.ResourceMetrics{Resource: &resource.Resource{Attributes: attrs}, ScopeMetrics: []*metrics.ScopeMetrics{{Scope: &common.InstrumentationScope{Name: "jood-monitor/metrics-api", Version: version}}}}
	for _, field := range []struct{ key, name, unit string }{{"cpu", cpuName, "{cpu}"}, {"memory", memName, "By"}} {
		raw, ok := usage[field.key]
		if !ok {
			continue
		}
		q, err := quantity.ParseQuantity(raw)
		if err != nil {
			continue
		}
		value := q.AsApproximateFloat64()
		p := &metrics.NumberDataPoint{TimeUnixNano: uint64(at.UnixNano()), Value: &metrics.NumberDataPoint_AsDouble{AsDouble: value}}
		if field.key == "memory" {
			p.Value = &metrics.NumberDataPoint_AsInt{AsInt: q.Value()}
		}
		rm.ScopeMetrics[0].Metrics = append(rm.ScopeMetrics[0].Metrics, &metrics.Metric{Name: field.name, Unit: field.unit, Data: &metrics.Metric_Gauge{Gauge: &metrics.Gauge{DataPoints: []*metrics.NumberDataPoint{p}}}})
	}
	return rm
}

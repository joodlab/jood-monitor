package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	collector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/proto"
)

func TestStandardCounterSelectionAndDiagnosticCoverage(t *testing.T) {
	proc := t.TempDir()
	if err := os.MkdirAll(filepath.Join(proc, "1", "net"), 0700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"stat":      "cpu 100 0 200 1000 0 0 0 0\nbtime 1700000000\n",
		"meminfo":   "MemTotal: 4096 kB\nMemAvailable: 1024 kB\n",
		"1/net/dev": "eth0: 9007199254740993 0 0 0 0 0 0 0 123 0 0 0 0 0 0 0\neth1: 200 0 0 0 0 0 0 0 300 0 0 0 0 0 0 0\nvethabc: 400 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0\nflannel.1: 600 0 0 0 0 0 0 0 700 0 0 0 0 0 0 0\nlo: 800 0 0 0 0 0 0 0 900 0 0 0 0 0 0 0\n",
		"diskstats": "8 0 sda 1 0 100 0 1 0 200 0 0 0 0\n8 1 sda1 1 0 50 0 1 0 60 0 0 0 0\n8 14 sda14 1 0 10 0 1 0 20 0 0 0 0\n7 0 loop0 1 0 30 0 1 0 40 0 0 0 0\n",
	}
	for name, text := range files {
		if err := os.WriteFile(filepath.Join(proc, name), []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	basic, err := readHost(proc, false)
	if err != nil || len(basic) != 10 {
		t.Fatalf("Basic coverage changed: %d %v", len(basic), err)
	}
	broad, err := readHost(proc, true)
	if err != nil || len(broad) != 24 {
		t.Fatalf("Diagnostic broad coverage changed: %d %v", len(broad), err)
	}
	selected, err := readHostSources(proc, true, map[string]bool{"eth0": true, "eth1": true, "absent": true}, map[string]bool{"sda": true, "absent": true})
	if err != nil || len(selected) != 16 {
		t.Fatalf("expected CPU/memory plus six selected counters, got %d %v", len(selected), err)
	}
	for _, point := range selected {
		if strings.HasPrefix(point.Attributes["interface"], "veth") || point.Attributes["interface"] == "flannel.1" || point.Attributes["device"] == "sda1" || point.Attributes["device"] == "sda14" {
			t.Fatal("unselected virtual/partition source passed through")
		}
	}
	if empty, err := readHostSources(proc, true, map[string]bool{}, map[string]bool{}); err != nil || len(empty) != len(basic) {
		t.Fatal("empty counter selections removed CPU/memory or invented zero values")
	}
	at := time.Now().UTC()
	out := &collector.ExportMetricsServiceRequest{}
	if err := proto.Unmarshal(hostOTLP(nodeBatch{NodeName: "node", SourceTime: at, StartTime: hostBootTime(proc), Points: selected, CollectionProfile: "standard"}, "node-uid"), out); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, metric := range out.ResourceMetrics[0].ScopeMetrics[0].Metrics {
		if metric.Name == "system.network.io" && attrValue(metric.GetSum().DataPoints[0].Attributes, "interface") == "eth0" && attrValue(metric.GetSum().DataPoints[0].Attributes, "direction") == "receive" {
			point := metric.GetSum().DataPoints[0]
			found = point.GetAsInt() == 9007199254740993 && point.TimeUnixNano == uint64(at.UnixNano()) && point.StartTimeUnixNano == 1700000000000000000 && metric.Unit == "By" && metric.GetSum().IsMonotonic
		}
	}
	if !found {
		t.Fatal("selected counter lost integer precision, time, source attributes or semantics")
	}
	// Filtering must precede the host series quota: a busy node's virtual links
	// must not suppress the selected physical counters or CPU/memory readings.
	net := files["1/net/dev"] + strings.Repeat("veth-extra: 400 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0\n", 300)
	if err := os.WriteFile(filepath.Join(proc, "1/net/dev"), []byte(net), 0600); err != nil {
		t.Fatal(err)
	}
	if points, err := readHostSources(proc, true, map[string]bool{"eth0": true}, map[string]bool{"sda": true}); err != nil || len(points) != 14 {
		t.Fatalf("virtual links exhausted selected-source quota: %d %v", len(points), err)
	}
	if _, err := readHost(proc, true); err == nil {
		t.Fatal("unbounded Diagnostic source quota was removed")
	}
}

func TestDeviceSelectionBounds(t *testing.T) {
	for _, raw := range []string{"", "[]", `["eth0","eth0","enp8s0.100"]`, `["nvme0n1","sda"]`} {
		if _, err := deviceSelection(raw); err != nil {
			t.Fatalf("valid selection rejected: %s", raw)
		}
	}
	tooMany := `[` + strings.Repeat(`"eth0",`, 16) + `"eth1"]`
	for _, raw := range []string{`null`, `{}`, `["../eth0"]`, `[""]`, `["eth 0"]`, `["` + strings.Repeat("x", 65) + `"]`, tooMany} {
		if _, err := deviceSelection(raw); err == nil {
			t.Fatalf("invalid or unbounded selection accepted: %s", raw)
		}
	}
}

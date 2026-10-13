package main

import (
	"fmt"
	"github.com/lord007tn/jood-monitor/internal/contracts"
	collector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/proto"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHostUnitsAndLosslessCounter(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "stat"), []byte("cpu 100 0 200 1000 0 0 0 0\nbtime 1700000000\n"), 0600); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "meminfo"), []byte("MemTotal: 4096 kB\nMemAvailable: 1024 kB\n"), 0600)
	_ = os.MkdirAll(filepath.Join(dir, "1/net"), 0700)
	_ = os.WriteFile(filepath.Join(dir, "1/net/dev"), []byte("eth0: 9007199254740993 0 0 0 0 0 0 0 123 0 0 0 0 0 0 0\n"), 0600)
	points, err := readHost(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	b := hostOTLP(nodeBatch{NodeName: "node", SourceTime: now, StartTime: hostBootTime(dir), Points: points}, "real-node-uid")
	var out collector.ExportMetricsServiceRequest
	if proto.Unmarshal(b, &out) != nil {
		t.Fatal("bad protobuf")
	}
	found := false
	for _, m := range out.ResourceMetrics[0].ScopeMetrics[0].Metrics {
		if m.Name == "system.cpu.time" && attrValue(m.GetSum().DataPoints[0].Attributes, "state") == "wait" {
			t.Fatal("unreliable iowait emitted as monotonic counter")
		}
		if m.Name == "system.network.io" && m.GetSum().DataPoints[0].GetAsInt() == 9007199254740993 {
			found = true
		}
		if m.Name == "system.cpu.time" && m.GetSum().DataPoints[0].StartTimeUnixNano != 1700000000000000000 {
			t.Fatal("counter start time not host boot")
		}
	}
	if !found {
		t.Fatal("network integer lost precision")
	}
}
func TestStartupJitterBoundedAndSpread(t *testing.T) {
	seen := map[time.Duration]bool{}
	for i := range 20 {
		d := nodeJitter(fmt.Sprintf("node-%d", i))
		if d < 0 || d >= 15*time.Second {
			t.Fatal("unbounded startup delay")
		}
		seen[d] = true
	}
	if len(seen) < 18 {
		t.Fatal("heartbeats remain synchronized")
	}
}
func TestDiagnosticReturnsPriorProfile(t *testing.T) {
	if returnProfile(contracts.Profile{ReturnProfile: "basic"}) != "basic" || returnProfile(contracts.Profile{ReturnProfile: "standard"}) != "standard" {
		t.Fatal("prior profile lost")
	}
}
func TestSpoolBound(t *testing.T) {
	s := spool{dir: t.TempDir(), max: 100}
	s.append(delivery{Path: "/test", Body: make([]byte, 200)})
	bytes, drops := s.stats()
	if bytes != 0 || drops != 1 {
		t.Fatal("spool quota failed")
	}
}

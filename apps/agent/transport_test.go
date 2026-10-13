package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	collector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/proto"
	"io"
	core "k8s.io/api/core/v1"
	quantity "k8s.io/apimachinery/pkg/api/resource"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestHubSpoolPreservesOrderAndRetryAfter(t *testing.T) {
	var mu sync.Mutex
	var received []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		reader, err := gzip.NewReader(r.Body)
		if err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		defer reader.Close()
		body, _ := io.ReadAll(reader)
		received = append(received, string(body))
		if len(received) == 1 {
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(429)
		}
	}))
	defer server.Close()
	credential := filepath.Join(t.TempDir(), "credential")
	_ = os.WriteFile(credential, []byte("fixture"), 0600)
	s := &spool{dir: t.TempDir(), max: 8192, hub: server.URL, client: server.Client(), credentialFile: credential}
	s.deliver(context.Background(), "/machine/v1/inventory", "PUT", "application/json", []byte("first"))
	s.deliver(context.Background(), "/machine/v1/heartbeat", "POST", "application/json", []byte("second"))
	s.flush(context.Background())
	mu.Lock()
	count := len(received)
	mu.Unlock()
	if count != 1 || time.Until(s.nextRetry) < 59*time.Second {
		t.Fatal("fresh delivery bypassed backoff or Retry-After")
	}
	s.nextRetry = time.Time{}
	s.flush(context.Background())
	mu.Lock()
	got := append([]string(nil), received...)
	mu.Unlock()
	if len(got) != 3 || got[1] != "first" || got[2] != "second" {
		t.Fatalf("backlog overtaken: %v", got)
	}
	queued, dropped := s.stats()
	if queued != 0 || dropped != 0 {
		t.Fatal("successful recovery lost buffered deliveries")
	}
}

func TestHubSpoolRestartPreservesOrderAcrossClockRollback(t *testing.T) {
	dir := t.TempDir()
	s := &spool{dir: dir, max: 8192, lastAppend: time.Now().UTC().Add(time.Hour)}
	s.append(delivery{Body: []byte("first")})
	// Reconstruct the spool as after a restart with an earlier wall clock.
	restarted := &spool{dir: dir, max: 8192}
	restarted.append(delivery{Body: []byte("second")})
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 2 {
		t.Fatal("restart lost spool entries", err)
	}
	first, _ := os.ReadFile(filepath.Join(dir, files[0].Name()))
	second, _ := os.ReadFile(filepath.Join(dir, files[1].Name()))
	var a, b delivery
	_ = json.Unmarshal(first, &a)
	_ = json.Unmarshal(second, &b)
	if string(a.Body) != "first" || string(b.Body) != "second" {
		t.Fatal("restart or clock rollback reordered backlog")
	}
}

func TestHubSpoolRetiresPermanentRejectionAndBoundsDrain(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if calls == 1 {
			w.WriteHeader(422)
		}
	}))
	defer server.Close()
	credential := filepath.Join(t.TempDir(), "credential")
	_ = os.WriteFile(credential, []byte("fixture"), 0600)
	s := &spool{dir: t.TempDir(), max: 65536, hub: server.URL, client: server.Client(), credentialFile: credential}
	for range 30 {
		s.append(delivery{Path: "/machine/v1/heartbeat", Method: "POST", Type: "application/json", Body: []byte("fixture")})
	}
	s.flush(context.Background())
	queued, dropped := s.stats()
	mu.Lock()
	count := calls
	mu.Unlock()
	if count != 16 || queued == 0 || dropped != 1 {
		t.Fatal("rejected item blocked backlog or reconnect drain was unbounded")
	}
	s.flush(context.Background())
	queued, dropped = s.stats()
	mu.Lock()
	count = calls
	mu.Unlock()
	if count != 30 || queued != 0 || dropped != 1 {
		t.Fatal("remaining valid backlog did not recover")
	}
}

func TestPartialSuccessIsCountedWithoutRetry(t *testing.T) {
	ack, _ := proto.Marshal(&collector.ExportMetricsServiceResponse{PartialSuccess: &collector.ExportMetricsPartialSuccess{RejectedDataPoints: 3, ErrorMessage: "unsupported"}})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(ack) }))
	defer server.Close()
	dir := t.TempDir()
	credential := filepath.Join(dir, "credential")
	_ = os.WriteFile(credential, []byte("fixture"), 0600)
	s := &spool{dir: t.TempDir(), max: 8192, hub: server.URL, client: server.Client(), credentialFile: credential}
	var tasks sync.WaitGroup
	for range 8 {
		tasks.Add(1)
		go func() {
			defer tasks.Done()
			s.deliver(context.Background(), "/v1/metrics", "POST", "application/x-protobuf", []byte{})
		}()
	}
	tasks.Wait()
	bytes, _ := s.stats()
	if bytes != 0 || s.rejectedPoints() != 24 {
		t.Fatal("partial success silently lost or retried")
	}
}
func TestAppliedResourcesRemainUnknownWithoutStatus(t *testing.T) {
	got := containerStates([]core.ContainerStatus{{Name: "absent"}, {Name: "applied", Resources: &core.ResourceRequirements{Requests: core.ResourceList{core.ResourceCPU: quantity.MustParse("250m")}}}}, true)
	if got[0].AppliedCPU != nil || got[0].AllocatedCPU != nil || !got[0].Init {
		t.Fatal("absent applied status fabricated")
	}
	if got[1].AppliedCPU == nil || *got[1].AppliedCPU != 0.25 || got[1].AppliedMemory != nil {
		t.Fatal("applied request misreported")
	}
}

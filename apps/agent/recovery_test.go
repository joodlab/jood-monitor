package main

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/lord007tn/jood-monitor/internal/contracts"
)

func TestReviewBufferedRetryAppliesProfile(t *testing.T) {
	dir := t.TempDir()
	for name, data := range map[string]string{
		"stat":    "cpu 100 0 100 200 0 0 0 0\nbtime 1700000000\n",
		"meminfo": "MemTotal: 1024 kB\nMemAvailable: 512 kB\n",
		"token":   "synthetic-test-token",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 38*time.Second)
	defer cancel()
	var mu sync.Mutex
	var calls, accepted, rejected int
	var seenNew bool
	var last time.Time
	expires := time.Now().Add(2 * time.Minute)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in nodeBatch
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		calls++
		if in.AppliedRevision == 3 {
			seenNew = true
			cancel()
		}
		if calls == 2 {
			w.WriteHeader(503)
			return
		}
		if time.Since(last) < 4*time.Second {
			rejected++
			w.WriteHeader(429)
			return
		}
		last = time.Now()
		accepted++
		profile := contracts.Profile{Name: "standard", Revision: 3}
		if calls == 1 {
			profile = contracts.Profile{Name: "diagnostic", Revision: 2, ReturnProfile: "basic", ExpiresAt: &expires}
		}
		_ = json.NewEncoder(w).Encode(nodeResponse{NodeUID: "synthetic-node", Profile: profile})
	}))
	defer server.Close()
	ca := filepath.Join(dir, "ca.crt")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JOOD_OBSERVER_URL", server.URL)
	t.Setenv("JOOD_OBSERVER_CA_FILE", ca)
	t.Setenv("JOOD_HOST_PROC", dir)
	t.Setenv("JOOD_TOKEN_FILE", filepath.Join(dir, "token"))
	t.Setenv("JOOD_NODE_NAME", "")
	t.Setenv("JOOD_FILESYSTEMS", "[]")
	if err := runNode(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	t.Logf("requests=%d accepted=%d immediate429=%d appliedRevision3=%t", calls, accepted, rejected, seenNew)
	if !seenNew {
		t.Fatal("buffered success never applied the returned Standard revision; fresh posts remained rate limited")
	}
	if rejected != 0 {
		t.Fatal("recovery sent an immediate rate-limited fresh sample")
	}
}

func TestNodeRetryClassifiesPermanentAndRateLimits(t *testing.T) {
	for _, code := range []int{400, 404, 413, 422} {
		if !permanentNodeError(&nodeSendError{status: code}) {
			t.Fatalf("HTTP %d would retry forever", code)
		}
	}
	for _, code := range []int{401, 403, 429, 503} {
		if permanentNodeError(&nodeSendError{status: code}) {
			t.Fatalf("HTTP %d would discard recoverable data", code)
		}
	}
	if got := nodeRetryDelay(&nodeSendError{status: 429, retryAfter: 40 * time.Second}, 1); got < 40*time.Second {
		t.Fatal("Retry-After ignored")
	}
	if got := nodeRetryDelay(&nodeSendError{status: 503}, 100); got != 60*time.Second {
		t.Fatal("retry backoff unbounded")
	}
}

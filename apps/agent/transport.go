package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lord007tn/jood-monitor/internal/agentutil"
	"github.com/lord007tn/jood-monitor/internal/contracts"
	collector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/proto"
)

type delivery struct {
	Path   string `json:"path"`
	Method string `json:"method"`
	Type   string `json:"type"`
	Body   []byte `json:"body"`
}
type hubDeliveryError struct {
	status     int
	retryAfter time.Duration
}

func (e *hubDeliveryError) Error() string { return "hub delivery rejected" }
func permanentHubError(err error) bool {
	var e *hubDeliveryError
	return errors.As(err, &e) && (e.status == 400 || e.status == 404 || e.status == 413 || e.status == 422)
}

type spool struct {
	dir                 string
	max                 int64
	mu                  sync.Mutex
	flushMu             sync.Mutex
	dropped             uint64
	rejected            uint64
	nextRetry           time.Time
	lastAppend          time.Time
	failures            int
	client              *http.Client
	hub, credentialFile string
}

func (s *spool) send(ctx context.Context, d delivery) error {
	token, err := os.ReadFile(s.credentialFile)
	if err != nil {
		return errors.New("credential file unavailable")
	}
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	_, _ = gz.Write(d.Body)
	_ = gz.Close()
	req, err := http.NewRequestWithContext(ctx, d.Method, s.hub+d.Path, &compressed)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	req.Header.Set("Content-Type", d.Type)
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("X-Jood-Batch-ID", agentutil.Hash(string(d.Body)))
	resp, err := s.client.Do(req)
	if err != nil {
		return errors.New("hub delivery unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		retryAfter := time.Duration(0)
		if seconds, e := strconv.Atoi(resp.Header.Get("Retry-After")); e == nil && seconds > 0 {
			retryAfter = time.Duration(seconds) * time.Second
		} else if at, e := http.ParseTime(resp.Header.Get("Retry-After")); e == nil {
			retryAfter = time.Until(at)
		}
		return &hubDeliveryError{status: resp.StatusCode, retryAfter: retryAfter}
	}
	if d.Type == "application/x-protobuf" {
		body, err := io.ReadAll(io.LimitReader(resp.Body, 32769))
		if err != nil || len(body) > 32768 {
			return errors.New("invalid OTLP acknowledgement")
		}
		ack := &collector.ExportMetricsServiceResponse{}
		if proto.Unmarshal(body, ack) != nil {
			return errors.New("invalid OTLP acknowledgement")
		}
		if rejected := ack.GetPartialSuccess().GetRejectedDataPoints(); rejected > 0 {
			s.mu.Lock()
			s.rejected += uint64(rejected)
			s.mu.Unlock()
		}
	} else {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	}
	return nil
}
func (s *spool) append(d delivery) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, _ := json.Marshal(d)
	size := s.bytesLocked()
	if size+int64(len(b)) > s.max {
		s.dropped++
		return
	}
	id, err := agentutil.Token()
	if err != nil {
		s.dropped++
		return
	}
	const timestampFormat = "20060102T150405.000000000"
	if s.lastAppend.IsZero() {
		files, _ := os.ReadDir(s.dir)
		for _, f := range files {
			prefix, _, _ := strings.Cut(f.Name(), "-")
			if at, err := time.Parse(timestampFormat, prefix); err == nil && at.After(s.lastAppend) {
				s.lastAppend = at
			}
		}
	}
	at := time.Now().UTC()
	if !at.After(s.lastAppend) {
		at = s.lastAppend.Add(time.Nanosecond)
	}
	s.lastAppend = at
	name := at.Format(timestampFormat) + "-" + id[:8] + ".json"
	tmp := filepath.Join(s.dir, name+".tmp")
	if os.WriteFile(tmp, b, 0600) != nil || os.Rename(tmp, filepath.Join(s.dir, name)) != nil {
		_ = os.Remove(tmp)
		s.dropped++
	}
}
func (s *spool) bytesLocked() int64 {
	files, _ := os.ReadDir(s.dir)
	var n int64
	for _, f := range files {
		if st, e := f.Info(); e == nil {
			n += st.Size()
		}
	}
	return n
}
func (s *spool) stats() (int64, uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bytesLocked(), s.dropped
}
func (s *spool) failed(err error, size int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failures < 6 {
		s.failures++
	}
	delay := time.Duration(1<<s.failures)*time.Second + time.Duration(size%1000)*time.Millisecond
	var rejected *hubDeliveryError
	if errors.As(err, &rejected) && rejected.retryAfter > delay {
		delay = rejected.retryAfter
	}
	s.nextRetry = time.Now().Add(delay)
}
func (s *spool) discard() { s.mu.Lock(); s.dropped++; s.mu.Unlock() }
func (s *spool) flush(ctx context.Context) {
	s.flushMu.Lock()
	defer s.flushMu.Unlock()
	s.mu.Lock()
	if time.Now().Before(s.nextRetry) {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	files, _ := os.ReadDir(s.dir)
	sort.Slice(files, func(i, j int) bool { return files[i].Name() < files[j].Name() })
	delivered := 0
	for _, f := range files {
		if ctx.Err() != nil || delivered >= 16 {
			return
		}
		if f.IsDir() || !strings.HasSuffix(f.Name(), ".json") {
			continue
		}
		p := filepath.Join(s.dir, f.Name())
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var d delivery
		if json.Unmarshal(b, &d) != nil {
			s.mu.Lock()
			s.dropped++
			s.mu.Unlock()
			_ = os.Remove(p)
			continue
		}
		delivered++
		if err := s.send(ctx, d); err != nil {
			if permanentHubError(err) {
				s.discard()
				_ = os.Remove(p)
				continue
			}
			s.failed(err, len(b))
			return
		}
		s.mu.Lock()
		s.failures = 0
		s.nextRetry = time.Time{}
		s.mu.Unlock()
		_ = os.Remove(p)
	}
}
func (s *spool) rejectedPoints() uint64 { s.mu.Lock(); defer s.mu.Unlock(); return s.rejected }
func (s *spool) deliver(ctx context.Context, path, method, typ string, body []byte) {
	s.flushMu.Lock()
	defer s.flushMu.Unlock()
	d := delivery{Path: path, Method: method, Type: typ, Body: body}
	s.mu.Lock()
	queued := s.bytesLocked() > 0 || time.Now().Before(s.nextRetry)
	s.mu.Unlock()
	if queued {
		s.append(d)
		return
	}
	if err := s.send(ctx, d); err != nil {
		if permanentHubError(err) {
			s.discard()
			return
		}
		s.failed(err, len(body))
		s.append(d)
	}
}
func readProfile(ctx context.Context, client *http.Client, url, file string) (contracts.Profile, error) {
	var p contracts.Profile
	token, err := os.ReadFile(file)
	if err != nil {
		return p, err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return p, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	resp, err := client.Do(req)
	if err != nil {
		return p, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return p, errors.New("profile unavailable")
	}
	err = json.NewDecoder(io.LimitReader(resp.Body, 32768)).Decode(&p)
	return p, err
}

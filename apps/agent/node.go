package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/lord007tn/jood-monitor/internal/contracts"
	collector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	common "go.opentelemetry.io/proto/otlp/common/v1"
	metrics "go.opentelemetry.io/proto/otlp/metrics/v1"
	resource "go.opentelemetry.io/proto/otlp/resource/v1"
	"google.golang.org/protobuf/proto"
)

type hostPoint struct {
	Name       string
	Unit       string
	Value      float64
	Integer    *int64
	Counter    bool
	Attributes map[string]string
}
type nodeBatch struct {
	NodeName          string      `json:"nodeName"`
	SourceTime        time.Time   `json:"sourceTime"`
	StartTime         time.Time   `json:"startTime"`
	Points            []hostPoint `json:"points"`
	Dropped           uint64      `json:"dropped"`
	AppliedRevision   uint64      `json:"appliedRevision"`
	AppliedProfile    string      `json:"appliedProfile"`
	Paused            bool        `json:"paused"`
	CollectionProfile string      `json:"collectionProfile"`
}
type nodeResponse struct {
	NodeUID string            `json:"nodeUid"`
	Profile contracts.Profile `json:"profile"`
}

func runNode(ctx context.Context) error {
	url := os.Getenv("JOOD_OBSERVER_URL")
	if !strings.HasPrefix(url, "https://") {
		return errors.New("HTTPS observer URL required")
	}
	client, err := secureClient(os.Getenv("JOOD_OBSERVER_CA_FILE"))
	if err != nil {
		return err
	}
	interfaces, err := deviceSelection(os.Getenv("JOOD_STANDARD_NETWORK_INTERFACES"))
	if err != nil {
		return errors.New("invalid Standard network interface selection")
	}
	disks, err := deviceSelection(os.Getenv("JOOD_STANDARD_DISK_DEVICES"))
	if err != nil {
		return errors.New("invalid Standard disk device selection")
	}
	start := hostBootTime(env("JOOD_HOST_PROC", "/host/proc"))
	p := contracts.Profile{Name: "basic"}
	var buffered *nodeBatch
	var dropped uint64
	var lastSample, lastSend, nextSend time.Time
	var failures uint
	// Stable node-specific jitter spreads projected-token identity checks at rollout.
	startup := time.NewTimer(nodeJitter(os.Getenv("JOOD_NODE_NAME")))
	select {
	case <-ctx.Done():
		startup.Stop()
		return nil
	case <-startup.C:
	}
	for {
		interval := hostSampleInterval(p, time.Now())
		if p.Name == "diagnostic" && (p.ExpiresAt == nil || time.Now().After(*p.ExpiresAt)) {
			p.Name = returnProfile(p)
			interval = hostSampleInterval(p, time.Now())
		}
		if time.Now().Before(nextSend) {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(time.Second):
			}
			continue
		}
		if buffered != nil && time.Since(buffered.SourceTime) >= 5*time.Minute {
			dropped++
			buffered = nil
		}
		points := []hostPoint{}
		if buffered == nil && !p.Paused && time.Since(lastSample) >= interval {
			proc := env("JOOD_HOST_PROC", "/host/proc")
			if p.Name == "standard" {
				points, err = readHostSources(proc, true, interfaces, disks)
			} else {
				points, err = readHost(proc, p.Name != "basic")
			}
			if err == nil {
				points = append(points, filesystemPoints()...)
			} else {
				points = nil
			}
			lastSample = time.Now()
		}
		if buffered == nil && len(points) == 0 && time.Since(lastSend) < 15*time.Second {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(time.Second):
			}
			continue
		}
		batch := nodeBatch{NodeName: os.Getenv("JOOD_NODE_NAME"), SourceTime: time.Now().UTC(), StartTime: start, Points: points, CollectionProfile: p.Name}
		if buffered != nil {
			batch = *buffered
		}
		// Acknowledgment describes the current control state; sample time stays intact.
		batch.Dropped, batch.AppliedRevision, batch.AppliedProfile, batch.Paused = dropped, p.Revision, p.Name, p.Paused
		result, err := sendNode(ctx, client, url, batch)
		lastSend = time.Now()
		nextSend = lastSend.Add(5 * time.Second)
		if err != nil {
			failures++
			nextSend = lastSend.Add(nodeRetryDelay(err, failures))
			if permanentNodeError(err) {
				if len(batch.Points) > 0 {
					dropped++
				}
				buffered = nil
			} else if len(batch.Points) > 0 {
				buffered = &batch
			}
		} else {
			p = result.Profile
			buffered = nil
			failures = 0
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(time.Second):
		}
	}
}

type nodeSendError struct {
	status     int
	retryAfter time.Duration
}

func (e *nodeSendError) Error() string {
	return fmt.Sprintf("observer rejected sample: HTTP %d", e.status)
}
func permanentNodeError(err error) bool {
	var e *nodeSendError
	return errors.As(err, &e) && (e.status == 400 || e.status == 404 || e.status == 413 || e.status == 422)
}
func nodeRetryDelay(err error, failures uint) time.Duration {
	delay := 5 * time.Second
	for i := uint(1); i < failures && delay < 60*time.Second; i++ {
		delay *= 2
	}
	if delay > 60*time.Second {
		delay = 60 * time.Second
	}
	var e *nodeSendError
	if errors.As(err, &e) && e.retryAfter > delay {
		delay = e.retryAfter
	}
	return delay
}
func nodeJitter(name string) time.Duration {
	hash := fnv.New32a()
	_, _ = hash.Write([]byte(name))
	return time.Duration(hash.Sum32()%15000) * time.Millisecond
}
func sendNode(ctx context.Context, client *http.Client, url string, batch nodeBatch) (nodeResponse, error) {
	var result nodeResponse
	token, err := os.ReadFile(env("JOOD_TOKEN_FILE", "/var/run/secrets/jood/token"))
	if err != nil {
		return result, err
	}
	b, _ := json.Marshal(batch)
	req, err := http.NewRequestWithContext(ctx, "POST", url+"/node/v1/collect", bytes.NewReader(b))
	if err != nil {
		return result, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return result, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		retryAfter := time.Duration(0)
		if seconds, e := strconv.Atoi(resp.Header.Get("Retry-After")); e == nil && seconds > 0 {
			retryAfter = time.Duration(seconds) * time.Second
		} else if at, e := http.ParseTime(resp.Header.Get("Retry-After")); e == nil {
			retryAfter = time.Until(at)
		}
		return result, &nodeSendError{status: resp.StatusCode, retryAfter: retryAfter}
	}
	err = json.NewDecoder(io.LimitReader(resp.Body, 32768)).Decode(&result)
	return result, err
}
func readHost(proc string, extended bool) ([]hostPoint, error) {
	return readHostSources(proc, extended, nil, nil)
}

func readHostSources(proc string, extended bool, interfaces, disks map[string]bool) ([]hostPoint, error) {
	out := []hostPoint{}
	stat, err := os.ReadFile(filepath.Join(proc, "stat"))
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(string(stat), "\n") {
		f := strings.Fields(line)
		if len(f) >= 9 && f[0] == "cpu" {
			states := []string{"user", "nice", "system", "idle", "wait", "interrupt", "softirq", "steal"}
			for i, state := range states {
				// Linux iowait may decrease and is not a monotonic CPU-time counter.
				if state == "wait" {
					continue
				}
				v, e := strconv.ParseFloat(f[i+1], 64)
				if e != nil {
					return nil, e
				}
				out = append(out, hostPoint{Name: "system.cpu.time", Unit: "s", Value: v / 100, Counter: true, Attributes: map[string]string{"state": state}})
			}
		}
	}
	mem, err := os.ReadFile(filepath.Join(proc, "meminfo"))
	if err != nil {
		return nil, err
	}
	vals := map[string]float64{}
	for _, line := range strings.Split(string(mem), "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 {
			v, _ := strconv.ParseFloat(f[1], 64)
			vals[strings.TrimSuffix(f[0], ":")] = v * 1024
		}
	}
	if vals["MemTotal"] <= 0 {
		return nil, errors.New("memory source unavailable")
	}
	out = append(out, hostPoint{Name: "system.memory.limit", Unit: "By", Value: vals["MemTotal"]}, hostPoint{Name: "system.memory.usage", Unit: "By", Value: vals["MemTotal"] - vals["MemAvailable"], Attributes: map[string]string{"state": "used"}}, hostPoint{Name: "system.memory.usage", Unit: "By", Value: vals["MemAvailable"], Attributes: map[string]string{"state": "available"}})
	if extended {
		netfile, err := os.Open(filepath.Join(proc, "1/net/dev"))
		if err == nil {
			defer netfile.Close()
			scan := bufio.NewScanner(netfile)
			for scan.Scan() {
				line := scan.Text()
				if !strings.Contains(line, ":") {
					continue
				}
				parts := strings.SplitN(line, ":", 2)
				device := strings.TrimSpace(parts[0])
				f := strings.Fields(parts[1])
				if device == "lo" || len(f) < 16 || interfaces != nil && !interfaces[device] {
					continue
				}
				for _, d := range []struct {
					name  string
					index int
				}{{"receive", 0}, {"transmit", 8}} {
					v, e := strconv.ParseInt(f[d.index], 10, 64)
					if e != nil {
						continue
					}
					out = append(out, hostPoint{Name: "system.network.io", Unit: "By", Value: float64(v), Integer: &v, Counter: true, Attributes: map[string]string{"direction": d.name, "interface": device}})
				}
			}
		}
		disk, err := os.ReadFile(filepath.Join(proc, "diskstats"))
		if err == nil {
			for _, line := range strings.Split(string(disk), "\n") {
				f := strings.Fields(line)
				if len(f) < 14 || strings.HasPrefix(f[2], "loop") || strings.HasPrefix(f[2], "ram") || disks != nil && !disks[f[2]] {
					continue
				}
				for _, d := range []struct {
					name  string
					index int
				}{{"read", 5}, {"write", 9}} {
					v, e := strconv.ParseInt(f[d.index], 10, 64)
					if e != nil {
						continue
					}
					v *= 512
					out = append(out, hostPoint{Name: "system.disk.io", Unit: "By", Value: float64(v), Integer: &v, Counter: true, Attributes: map[string]string{"direction": d.name, "device": f[2]}})
				}
			}
		}
	}
	if len(out) > 512 {
		return nil, fmt.Errorf("host series quota exceeded")
	}
	return out, nil
}
func kv(k, v string) *common.KeyValue {
	return &common.KeyValue{Key: k, Value: &common.AnyValue{Value: &common.AnyValue_StringValue{StringValue: v}}}
}
func attrValue(attrs []*common.KeyValue, key string) string {
	for _, a := range attrs {
		if a.Key == key {
			return a.Value.GetStringValue()
		}
	}
	return ""
}
func hostOTLP(batch nodeBatch, nodeUID string) []byte {
	rm := &metrics.ResourceMetrics{Resource: &resource.Resource{Attributes: []*common.KeyValue{kv("k8s.node.uid", nodeUID), kv("k8s.node.name", batch.NodeName)}}, ScopeMetrics: []*metrics.ScopeMetrics{{Scope: &common.InstrumentationScope{Name: "jood-monitor/host", Version: version}}}}
	if batch.CollectionProfile != "" {
		rm.Resource.Attributes = append(rm.Resource.Attributes, kv("jood.collection.profile", batch.CollectionProfile))
	}
	for _, point := range batch.Points {
		dp := &metrics.NumberDataPoint{TimeUnixNano: uint64(batch.SourceTime.UnixNano()), Value: &metrics.NumberDataPoint_AsDouble{AsDouble: point.Value}}
		if point.Integer != nil {
			dp.Value = &metrics.NumberDataPoint_AsInt{AsInt: *point.Integer}
		}
		for k, v := range point.Attributes {
			dp.Attributes = append(dp.Attributes, kv(k, v))
		}
		m := &metrics.Metric{Name: point.Name, Unit: point.Unit}
		if point.Counter {
			dp.StartTimeUnixNano = uint64(batch.StartTime.UnixNano())
			m.Data = &metrics.Metric_Sum{Sum: &metrics.Sum{IsMonotonic: true, AggregationTemporality: metrics.AggregationTemporality_AGGREGATION_TEMPORALITY_CUMULATIVE, DataPoints: []*metrics.NumberDataPoint{dp}}}
		} else {
			m.Data = &metrics.Metric_Gauge{Gauge: &metrics.Gauge{DataPoints: []*metrics.NumberDataPoint{dp}}}
		}
		rm.ScopeMetrics[0].Metrics = append(rm.ScopeMetrics[0].Metrics, m)
	}
	b, _ := proto.Marshal(&collector.ExportMetricsServiceRequest{ResourceMetrics: []*metrics.ResourceMetrics{rm}})
	return b
}

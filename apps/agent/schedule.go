package main

import (
	"time"

	"github.com/lord007tn/jood-monitor/internal/contracts"
)

// sampleSchedule keeps successful reads on the loop's original clock phase.
// Request and delivery duration must not add another ticker interval to every read.
type sampleSchedule struct {
	next     time.Time
	interval time.Duration
}

func (s sampleSchedule) due(now time.Time, interval time.Duration) bool {
	return s.next.IsZero() || s.interval != interval || !now.Before(s.next)
}

func (s *sampleSchedule) collected(now, origin time.Time, interval time.Duration) {
	s.interval = interval
	s.next = origin.Add((now.Sub(origin)/interval + 1) * interval)
}

func resourceSampleInterval(p contracts.Profile) time.Duration {
	if p.Name == "basic" {
		return 60 * time.Second
	}
	return 30 * time.Second
}

func hostSampleInterval(p contracts.Profile, now time.Time) time.Duration {
	if p.Name == "diagnostic" && p.ExpiresAt != nil && now.Before(*p.ExpiresAt) {
		return 5 * time.Second
	}
	// API CPU/memory remains at 30s in Standard. Host counters use 60s to
	// offset the faster Pod reads within the measured ingestion envelope.
	return 60 * time.Second
}

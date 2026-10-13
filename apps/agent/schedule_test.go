package main

import (
	"testing"
	"time"

	"github.com/lord007tn/jood-monitor/internal/contracts"
)

func TestRequestDurationDoesNotShiftSamplingDeadline(t *testing.T) {
	origin := time.Unix(1700000000, 0)
	var schedule sampleSchedule
	interval := 30 * time.Second
	for _, seconds := range []int{0, 30, 60, 90} {
		started := origin.Add(time.Duration(seconds) * time.Second)
		if !schedule.due(started, interval) {
			t.Fatalf("request completion delayed the scheduled read at %ds", seconds)
		}
		schedule.collected(started.Add(250*time.Millisecond), origin, interval)
		if schedule.due(started.Add(15*time.Second), interval) {
			t.Fatal("sampling exceeded the planned cadence")
		}
	}
}

func TestSlowReadSkipsMissedSlotsAndFailedReadCanRetry(t *testing.T) {
	origin := time.Unix(1700000000, 0)
	var schedule sampleSchedule
	interval := 30 * time.Second
	// A failed read does not call collected; it is eligible at the next tick.
	if !schedule.due(origin, interval) || !schedule.due(origin.Add(15*time.Second), interval) {
		t.Fatal("failed read suppressed the next retry")
	}
	schedule.collected(origin.Add(95*time.Second), origin, interval)
	if schedule.due(origin.Add(105*time.Second), interval) || !schedule.due(origin.Add(120*time.Second), interval) {
		t.Fatal("slow read caused catch-up bursts or shifted the original phase")
	}
	if !schedule.due(origin.Add(105*time.Second), 60*time.Second) {
		t.Fatal("profile cadence change did not become eligible")
	}
}

func TestProfileSourceCadencesAndDiagnosticExpiry(t *testing.T) {
	now := time.Unix(1700000000, 0)
	expires := now.Add(time.Minute)
	for _, name := range []string{"basic", "standard"} {
		p := contracts.Profile{Name: name}
		if hostSampleInterval(p, now) != 60*time.Second {
			t.Fatalf("%s host cadence exceeded its budget", name)
		}
		want := 30 * time.Second
		if name == "basic" {
			want = 60 * time.Second
		}
		if resourceSampleInterval(p) != want {
			t.Fatalf("%s API cadence is incorrect", name)
		}
	}
	p := contracts.Profile{Name: "diagnostic", ExpiresAt: &expires, ReturnProfile: "standard"}
	if hostSampleInterval(p, now) != 5*time.Second || resourceSampleInterval(p) != 30*time.Second {
		t.Fatal("Diagnostic source cadences changed")
	}
	if hostSampleInterval(p, expires) != 60*time.Second {
		t.Fatal("expired Diagnostic retained its fast host cadence")
	}
	p.ExpiresAt = nil
	if hostSampleInterval(p, now) != 60*time.Second {
		t.Fatal("Diagnostic without expiry enabled fast collection")
	}
}

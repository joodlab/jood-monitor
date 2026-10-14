package main

import (
	"strings"
	"testing"
)

func TestSpoolMaximumBytes(t *testing.T) {
	for _, test := range []struct {
		value string
		want  int64
	}{
		{"", 8 << 20},
		{"8388608", 8 << 20},
		{"33554432", 32 << 20},
		{"268435456", 256 << 20},
	} {
		t.Run(test.value, func(t *testing.T) {
			got, err := spoolMaximumBytes(test.value)
			if err != nil || got != test.want {
				t.Fatalf("maximum=%d, error=%v; want %d", got, err, test.want)
			}
		})
	}
}

func TestSpoolMaximumRejectsInvalidValuesWithoutEcho(t *testing.T) {
	for _, value := range []string{"0", "-1", "8388607", "268435457", "33554432.5", "9223372036854775808", "private-invalid-value"} {
		t.Run(value, func(t *testing.T) {
			got, err := spoolMaximumBytes(value)
			if got != 0 || err == nil {
				t.Fatal("invalid maximum accepted")
			}
			if value == "private-invalid-value" && strings.Contains(err.Error(), value) {
				t.Fatal("invalid setting echoed")
			}
		})
	}
}

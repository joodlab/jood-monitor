package main

import (
	"github.com/lord007tn/jood-monitor/internal/contracts"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func returnProfile(p contracts.Profile) string {
	if p.ReturnProfile == "standard" {
		return "standard"
	}
	return "basic"
}
func effectiveNodeProfile(p contracts.Profile, uid string) string {
	if p.Name != "diagnostic" {
		return p.Name
	}
	if p.ExpiresAt != nil && time.Now().Before(*p.ExpiresAt) {
		for _, selected := range p.NodeUIDs {
			if selected == uid {
				return "diagnostic"
			}
		}
	}
	return returnProfile(p)
}
func hostBootTime(proc string) time.Time {
	data, err := os.ReadFile(filepath.Join(proc, "stat"))
	if err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			f := strings.Fields(line)
			if len(f) == 2 && f[0] == "btime" {
				seconds, err := strconv.ParseInt(f[1], 10, 64)
				if err == nil {
					return time.Unix(seconds, 0).UTC()
				}
			}
		}
	}
	return time.Now().UTC()
}

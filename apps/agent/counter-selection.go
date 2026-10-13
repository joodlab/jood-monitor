package main

import (
	"encoding/json"
	"errors"
	"strings"
)

// Standard chooses known sources rather than multiplying series for every
// virtual interface and partition. Diagnostic retains the broader host view.
func deviceSelection(raw string) (map[string]bool, error) {
	selected := map[string]bool{}
	if raw == "" {
		return selected, nil
	}
	var names []string
	if err := json.Unmarshal([]byte(raw), &names); err != nil || names == nil || len(names) > 16 {
		return nil, errors.New("expected up to sixteen device names")
	}
	for _, name := range names {
		if len(name) == 0 || len(name) > 64 || strings.IndexFunc(name, func(r rune) bool {
			switch {
			case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', strings.ContainsRune("_.:-", r):
				return false
			default:
				return true
			}
		}) >= 0 {
			return nil, errors.New("invalid device name")
		}
		selected[name] = true
	}
	return selected, nil
}

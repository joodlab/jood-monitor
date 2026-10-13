//go:build !linux && !windows

package main

func filesystemPoints() []hostPoint { return nil }

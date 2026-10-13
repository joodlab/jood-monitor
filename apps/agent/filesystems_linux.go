//go:build linux

package main

import (
	"encoding/json"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
)

type filesystemDescriptor struct {
	Name        string `json:"name"`
	HostPath    string `json:"hostPath"`
	LogicalPath string `json:"logicalPath"`
}

func filesystemPoints() []hostPoint {
	var descriptors []filesystemDescriptor
	if json.Unmarshal([]byte(os.Getenv("JOOD_FILESYSTEMS")), &descriptors) != nil || len(descriptors) > 8 {
		return nil
	}
	points := []hostPoint{}
	for _, d := range descriptors {
		if filepath.Base(d.Name) != d.Name || d.Name == "" {
			continue
		}
		var st unix.Statfs_t
		if unix.Statfs("/host/fs/"+d.Name, &st) != nil {
			continue
		}
		for _, v := range []struct {
			state string
			value uint64
		}{{"used", (st.Blocks - st.Bfree) * uint64(st.Bsize)}, {"free", st.Bavail * uint64(st.Bsize)}} {
			n := int64(v.value)
			points = append(points, hostPoint{Name: "system.filesystem.usage", Unit: "By", Value: float64(n), Integer: &n, Attributes: map[string]string{"state": v.state, "mountpoint": d.LogicalPath}})
		}
		total := int64(st.Files)
		used := int64(st.Files - st.Ffree)
		points = append(points, hostPoint{Name: "system.filesystem.inodes.usage", Unit: "{inode}", Value: float64(total), Integer: &total, Attributes: map[string]string{"state": "total", "mountpoint": d.LogicalPath}}, hostPoint{Name: "system.filesystem.inodes.usage", Unit: "{inode}", Value: float64(used), Integer: &used, Attributes: map[string]string{"state": "used", "mountpoint": d.LogicalPath}})
	}
	return points
}

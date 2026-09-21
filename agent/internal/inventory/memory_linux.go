package inventory

import (
	"fmt"
	"strconv"
	"strings"
)

func DiscoverMemory(probe Probe) (MemoryInventory, error) {
	data, err := probe.ReadFile("/proc/meminfo")
	if err != nil {
		return MemoryInventory{}, fmt.Errorf("read /proc/meminfo: %w", err)
	}
	var totalBytes uint64
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "MemTotal:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			break
		}
		kib, parseErr := strconv.ParseUint(fields[1], 10, 64)
		if parseErr != nil {
			return MemoryInventory{}, fmt.Errorf("parse MemTotal: %w", parseErr)
		}
		totalBytes = kib * 1024
		break
	}
	if totalBytes == 0 {
		return MemoryInventory{}, fmt.Errorf("MemTotal is unavailable")
	}

	numaNodes := 1
	if entries, err := probe.ReadDir("/sys/devices/system/node"); err == nil {
		count := 0
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() && strings.HasPrefix(name, "node") {
				if _, parseErr := strconv.Atoi(strings.TrimPrefix(name, "node")); parseErr == nil {
					count++
				}
			}
		}
		if count > 0 {
			numaNodes = count
		}
	}

	return MemoryInventory{
		TotalBytes: totalBytes,
		NUMANodes:  numaNodes,
	}, nil
}

package inventory

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func DiscoverCPU(ctx context.Context, probe Probe, goarch string) (CPUInventory, error) {
	architecture, err := protocolArchitecture(goarch)
	if err != nil {
		return CPUInventory{}, err
	}
	data, err := probe.ReadFile("/proc/cpuinfo")
	if err != nil {
		return CPUInventory{}, fmt.Errorf("read /proc/cpuinfo: %w", err)
	}
	records := parseCPUInfo(string(data))
	if len(records) == 0 {
		return CPUInventory{}, errors.New("no CPU records discovered")
	}

	logicalThreads := len(records)
	if online, err := probe.ReadFile("/sys/devices/system/cpu/online"); err == nil {
		if count := countCPUList(strings.TrimSpace(string(online))); count > 0 {
			logicalThreads = count
		}
	}

	first := records[0]
	vendor := first["vendor_id"]
	if vendor == "" {
		vendor = first["cpu implementer"]
	}
	model := first["model name"]
	if model == "" {
		model = first["hardware"]
	}
	if model == "" {
		model = first["processor"]
	}
	if model == "" {
		model = "unknown"
	}

	socketSet := map[string]struct{}{}
	coreSet := map[string]struct{}{}
	virtualization := false
	var frequencyMHz float64
	for index, record := range records {
		physical := record["physical id"]
		if physical == "" {
			physical = "0"
		}
		socketSet[physical] = struct{}{}
		core := record["core id"]
		if core == "" {
			core = strconv.Itoa(index)
		}
		coreSet[physical+":"+core] = struct{}{}

		flags := " " + record["flags"] + " " + record["features"] + " "
		if strings.Contains(flags, " vmx ") || strings.Contains(flags, " svm ") || strings.Contains(flags, " virt ") {
			virtualization = true
		}
		if frequencyMHz == 0 {
			if raw := record["cpu mhz"]; raw != "" {
				if value, parseErr := strconv.ParseFloat(raw, 64); parseErr == nil {
					frequencyMHz = value
				}
			}
		}
	}
	if maxFreq, err := probe.ReadFile("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq"); err == nil {
		if khz, parseErr := strconv.ParseFloat(strings.TrimSpace(string(maxFreq)), 64); parseErr == nil && khz > 0 {
			frequencyMHz = khz / 1000
		}
	}

	physicalCores := len(coreSet)
	if physicalCores <= 0 || physicalCores > logicalThreads {
		physicalCores = logicalThreads
	}
	sockets := len(socketSet)
	if sockets == 0 {
		sockets = 1
	}

	return CPUInventory{
		Architecture:            architecture,
		Vendor:                  vendor,
		Model:                   model,
		Sockets:                 sockets,
		PhysicalCores:           physicalCores,
		LogicalThreads:          logicalThreads,
		FrequencyMHz:            frequencyMHz,
		VirtualizationSupported: virtualization,
	}, nil
}

func protocolArchitecture(goarch string) (string, error) {
	switch goarch {
	case "amd64":
		return "x86_64", nil
	case "arm64":
		return "arm64", nil
	default:
		return "", fmt.Errorf("unsupported Node architecture %q", goarch)
	}
}

func parseCPUInfo(raw string) []map[string]string {
	blocks := strings.Split(strings.TrimSpace(raw), "\n\n")
	records := make([]map[string]string, 0, len(blocks))
	for _, block := range blocks {
		record := map[string]string{}
		for _, line := range strings.Split(block, "\n") {
			key, value, ok := strings.Cut(line, ":")
			if !ok {
				continue
			}
			record[strings.ToLower(strings.TrimSpace(key))] = strings.TrimSpace(value)
		}
		if len(record) > 0 {
			records = append(records, record)
		}
	}
	return records
}

func countCPUList(value string) int {
	if value == "" {
		return 0
	}
	total := 0
	for _, token := range strings.Split(value, ",") {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		if left, right, ok := strings.Cut(token, "-"); ok {
			start, errStart := strconv.Atoi(left)
			end, errEnd := strconv.Atoi(right)
			if errStart == nil && errEnd == nil && end >= start {
				total += end - start + 1
			}
			continue
		}
		if _, err := strconv.Atoi(token); err == nil {
			total++
		}
	}
	return total
}

func isNotExist(err error) bool {
	return errors.Is(err, os.ErrNotExist)
}

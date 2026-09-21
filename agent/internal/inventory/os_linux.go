package inventory

import (
	"context"
	"fmt"
	"strings"
)

func DiscoverOS(ctx context.Context, probe Probe) (OSInventory, error) {
	data, err := probe.ReadFile("/etc/os-release")
	if err != nil {
		return OSInventory{}, fmt.Errorf("read /etc/os-release: %w", err)
	}
	values := parseOSRelease(string(data))
	distribution := values["PRETTY_NAME"]
	if distribution == "" {
		distribution = values["NAME"]
	}
	if distribution == "" {
		distribution = values["ID"]
	}
	if distribution == "" {
		distribution = "linux"
	}
	version := values["VERSION_ID"]
	if version == "" {
		version = values["VERSION"]
	}
	if version == "" {
		version = "unknown"
	}

	kernel := ""
	if output, runErr := probe.Run(ctx, "uname", "-r"); runErr == nil {
		kernel = strings.TrimSpace(string(output))
	}
	if kernel == "" {
		if data, readErr := probe.ReadFile("/proc/sys/kernel/osrelease"); readErr == nil {
			kernel = strings.TrimSpace(string(data))
		}
	}
	if kernel == "" {
		return OSInventory{}, fmt.Errorf("kernel version is unavailable")
	}

	return OSInventory{
		Distribution: distribution,
		Version:      version,
		Kernel:       kernel,
	}, nil
}

func DiscoverCgroups(probe Probe) CgroupInventory {
	if _, err := probe.ReadFile("/sys/fs/cgroup/cgroup.controllers"); err == nil {
		return CgroupInventory{Version: 2, Available: true}
	}
	if _, err := probe.ReadDir("/sys/fs/cgroup"); err == nil {
		return CgroupInventory{Version: 1, Available: true}
	}
	return CgroupInventory{Version: 1, Available: false}
}

func parseOSRelease(raw string) map[string]string {
	values := map[string]string{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		values[key] = strings.Trim(strings.TrimSpace(value), "\"'")
	}
	return values
}

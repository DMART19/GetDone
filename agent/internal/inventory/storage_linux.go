package inventory

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
)

type lsblkDevice struct {
	Name        string        `json:"name"`
	KName       string        `json:"kname"`
	Path        string        `json:"path"`
	Mountpoints []string      `json:"mountpoints"`
	FSType      string        `json:"fstype"`
	Size        uint64        `json:"size"`
	Rotational  bool          `json:"rota"`
	Removable   bool          `json:"rm"`
	Type        string        `json:"type"`
	Children    []lsblkDevice `json:"children"`
}

func DiscoverStorage(ctx context.Context, probe Probe) ([]StorageDevice, error) {
	output, err := probe.Run(
		ctx,
		"lsblk",
		"-J",
		"-b",
		"-o",
		"NAME,KNAME,PATH,MOUNTPOINTS,FSTYPE,SIZE,ROTA,RM,TYPE",
	)
	if err != nil {
		return []StorageDevice{}, nil
	}
	var payload struct {
		BlockDevices []lsblkDevice `json:"blockdevices"`
	}
	if err := json.Unmarshal(output, &payload); err != nil {
		return nil, err
	}

	var flat []lsblkDevice
	var walk func([]lsblkDevice)
	walk = func(devices []lsblkDevice) {
		for _, device := range devices {
			flat = append(flat, device)
			walk(device.Children)
		}
	}
	walk(payload.BlockDevices)

	result := make([]StorageDevice, 0, len(flat))
	for _, device := range flat {
		if device.Path == "" || device.Size == 0 {
			continue
		}
		if device.Type != "disk" && device.Type != "part" && device.Type != "lvm" && device.Type != "crypt" {
			continue
		}
		mount := firstMount(device.Mountpoints)
		available := device.Size
		if mount != "" {
			if stats, statErr := probe.StatFS(mount); statErr == nil {
				if stats.TotalBytes > 0 {
					device.Size = stats.TotalBytes
				}
				available = stats.AvailableBytes
			}
		}
		result = append(result, StorageDevice{
			ID:             "storage-" + shortHash(device.Path),
			Device:         device.Path,
			Mount:          sanitizeMountPath(mount),
			Filesystem:     device.FSType,
			TotalBytes:     device.Size,
			AvailableBytes: available,
			Rotational:     device.Rotational,
			Removable:      device.Removable,
			NVMe: strings.Contains(strings.ToLower(device.Name), "nvme") ||
				strings.Contains(strings.ToLower(device.KName), "nvme") ||
				strings.Contains(strings.ToLower(device.Path), "nvme"),
		})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Device < result[j].Device
	})
	return result, nil
}

func firstMount(values []string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return filepath.Clean(value)
		}
	}
	return ""
}

func sanitizeMountPath(value string) string {
	if value == "" {
		return ""
	}
	clean := filepath.Clean(value)
	switch clean {
	case "/", "/var", "/home", "/srv", "/opt", "/tmp", "/mnt", "/data":
		return clean
	}
	for _, prefix := range []string{"/mnt/", "/srv/", "/data/"} {
		if strings.HasPrefix(clean, prefix) {
			return strings.TrimSuffix(prefix, "/") + "/[redacted]"
		}
	}
	return ""
}

func shortHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}

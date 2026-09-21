package inventory

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
)

type AMDDetector struct{}

func (AMDDetector) Detect(ctx context.Context, probe Probe) ([]GPUDevice, error) {
	output, err := probe.Run(
		ctx,
		"rocm-smi",
		"--showproductname",
		"--showmeminfo",
		"vram",
		"--showdriverversion",
		"--json",
	)
	if err != nil {
		return []GPUDevice{}, nil
	}
	var payload map[string]map[string]any
	if err := json.Unmarshal(output, &payload); err != nil {
		return nil, err
	}
	result := make([]GPUDevice, 0, len(payload))
	for card, values := range payload {
		model := firstString(values, "Card series", "Card model", "Device Name")
		if model == "" {
			model = "AMD GPU"
		}
		memoryBytes := firstUint(values, "VRAM Total Memory (B)", "VRAM Total Used Memory (B)")
		driver := firstString(values, "Driver version", "Driver Version")
		result = append(result, GPUDevice{
			ID: "gpu-amd-" + strings.TrimPrefix(card, "card"),
			Vendor: "amd",
			Model: model,
			MemoryBytes: memoryBytes,
			ComputeCapabilities: []string{"rocm"},
			DriverVersion: driver,
			Health: "healthy",
		})
	}
	return result, nil
}

func firstString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		switch value := values[key].(type) {
		case string:
			if strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value)
			}
		case float64:
			return strconv.FormatFloat(value, 'f', -1, 64)
		}
	}
	return ""
}

func firstUint(values map[string]any, keys ...string) uint64 {
	for _, key := range keys {
		value, exists := values[key]
		if !exists {
			continue
		}
		switch typed := value.(type) {
		case float64:
			if typed >= 0 {
				return uint64(typed)
			}
		case string:
			parsed, err := strconv.ParseUint(strings.TrimSpace(typed), 10, 64)
			if err == nil {
				return parsed
			}
		}
	}
	return 0
}

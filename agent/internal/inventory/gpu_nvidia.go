package inventory

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

type NVIDIADetector struct{}

func (NVIDIADetector) Detect(ctx context.Context, probe Probe) ([]GPUDevice, error) {
	output, err := probe.Run(
		ctx,
		"nvidia-smi",
		"--query-gpu=index,name,memory.total,driver_version",
		"--format=csv,noheader,nounits",
	)
	if err != nil {
		return []GPUDevice{}, nil
	}
	computeCaps := map[string]string{}
	if capabilityOutput, capabilityErr := probe.Run(
		ctx,
		"nvidia-smi",
		"--query-gpu=index,compute_cap",
		"--format=csv,noheader,nounits",
	); capabilityErr == nil {
		for _, line := range strings.Split(strings.TrimSpace(string(capabilityOutput)), "\n") {
			fields := splitCSVLine(line)
			if len(fields) >= 2 {
				computeCaps[fields[0]] = fields[1]
			}
		}
	}

	var result []GPUDevice
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := splitCSVLine(line)
		if len(fields) < 4 {
			return nil, fmt.Errorf("unexpected nvidia-smi inventory row")
		}
		memoryMiB, parseErr := strconv.ParseUint(fields[2], 10, 64)
		if parseErr != nil {
			return nil, parseErr
		}
		capabilities := []string{}
		if value := computeCaps[fields[0]]; value != "" {
			capabilities = append(capabilities, "cuda-compute-"+value)
		}
		result = append(result, GPUDevice{
			ID:                  "gpu-nvidia-" + fields[0],
			Vendor:              "nvidia",
			Model:               fields[1],
			MemoryBytes:         memoryMiB * 1024 * 1024,
			ComputeCapabilities: capabilities,
			DriverVersion:       fields[3],
			Health:              "healthy",
		})
	}
	return result, nil
}

func splitCSVLine(line string) []string {
	raw := strings.Split(line, ",")
	result := make([]string, 0, len(raw))
	for _, value := range raw {
		result = append(result, strings.TrimSpace(value))
	}
	return result
}

package inventory

import (
	"context"
	"sort"
)

type GPUDetector interface {
	Detect(ctx context.Context, probe Probe) ([]GPUDevice, error)
}

func DiscoverGPUs(ctx context.Context, probe Probe) ([]GPUDevice, error) {
	var result []GPUDevice
	for _, detector := range []GPUDetector{
		NVIDIADetector{},
		AMDDetector{},
	} {
		devices, err := detector.Detect(ctx, probe)
		if err != nil {
			continue
		}
		result = append(result, devices...)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Vendor == result[j].Vendor {
			return result[i].ID < result[j].ID
		}
		return result[i].Vendor < result[j].Vendor
	})
	return result, nil
}

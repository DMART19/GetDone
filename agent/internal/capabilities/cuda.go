package capabilities

import (
	"context"
	"time"
)

type CUDADetector struct{ Runner Runner }

func (CUDADetector) Name() string { return "gpu.cuda" }

func (d CUDADetector) Detect(ctx context.Context) Result {
	out, err := runBounded(
		ctx,
		d.Runner,
		5*time.Second,
		"nvidia-smi",
		"--query-gpu=driver_version",
		"--format=csv,noheader",
	)
	if err != nil {
		return absent()
	}
	return detected(d.Name(), cleanVersion(out), map[string]any{"gpuRuntime": "cuda"})
}

func (d CUDADetector) Validate(ctx context.Context) ValidationResult {
	out, err := runBounded(
		ctx,
		d.Runner,
		8*time.Second,
		"nvidia-smi",
		"--query-gpu=index,compute_cap",
		"--format=csv,noheader,nounits",
	)
	if err != nil {
		return invalid()
	}
	return valid(d.Name(), cleanVersion(out), map[string]any{
		"gpuRuntime": "cuda",
		"driverValidated": true,
	})
}

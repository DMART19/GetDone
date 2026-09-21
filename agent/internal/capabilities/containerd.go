package capabilities

import (
	"context"
	"time"
)

type ContainerdDetector struct{ Runner Runner }

func (ContainerdDetector) Name() string { return "runtime.containerd" }

func (d ContainerdDetector) Detect(ctx context.Context) Result {
	out, err := runBounded(ctx, d.Runner, 5*time.Second, "ctr", "version")
	if err != nil {
		return absent()
	}
	return detected(d.Name(), cleanVersion(out), map[string]any{"runtime": "containerd"})
}

func (d ContainerdDetector) Validate(ctx context.Context) ValidationResult {
	out, err := runBounded(ctx, d.Runner, 8*time.Second, "ctr", "plugins", "ls")
	if err != nil {
		return invalid()
	}
	return valid(d.Name(), cleanVersion(out), map[string]any{
		"runtime":    "containerd",
		"validation": "daemon-plugin-probe",
	})
}

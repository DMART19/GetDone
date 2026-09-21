package capabilities

import (
	"context"
	"time"
)

type DockerDetector struct{ Runner Runner }

func (DockerDetector) Name() string { return "runtime.docker" }

func (d DockerDetector) Detect(ctx context.Context) Result {
	out, err := runBounded(ctx, d.Runner, 5*time.Second, "docker", "--version")
	if err != nil {
		return absent()
	}
	return detected(d.Name(), cleanVersion(out), map[string]any{"runtime": "docker"})
}

func (d DockerDetector) Validate(ctx context.Context) ValidationResult {
	out, err := runBounded(
		ctx,
		d.Runner,
		15*time.Second,
		"docker",
		"run",
		"--rm",
		"--pull=never",
		"--network=none",
		"--read-only",
		"--cap-drop=ALL",
		"--pids-limit=16",
		"--memory=32m",
		"--cpus=0.25",
		"busybox:latest",
		"true",
	)
	if err != nil {
		return invalid()
	}
	return valid(d.Name(), cleanVersion(out), map[string]any{
		"runtime":    "docker",
		"validation": "sandboxed-container",
	})
}

package capabilities

import (
	"context"
	"os/exec"
	"time"
)

type LinuxRunner struct{}

func (LinuxRunner) Run(
	ctx context.Context,
	name string,
	args ...string,
) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func runBounded(
	ctx context.Context,
	runner Runner,
	timeout time.Duration,
	name string,
	args ...string,
) ([]byte, error) {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return runner.Run(probeCtx, name, args...)
}

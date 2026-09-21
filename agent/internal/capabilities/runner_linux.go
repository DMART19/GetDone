package capabilities

import (
	"context"
	"os/exec"
)

type LinuxRunner struct{}

func (LinuxRunner) Run(
	ctx context.Context,
	name string,
	args ...string,
) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

package capabilities

import (
	"context"
	"time"
)

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

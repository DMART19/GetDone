package capabilities

import (
	"context"
	"time"
)

type NodeJSDetector struct{ Runner Runner }

func (NodeJSDetector) Name() string { return "runtime.nodejs" }

func (d NodeJSDetector) Detect(ctx context.Context) Result {
	out, err := runBounded(ctx, d.Runner, 5*time.Second, "node", "--version")
	if err != nil {
		return absent()
	}
	return detected(d.Name(), cleanVersion(out), map[string]any{"runtime": "nodejs"})
}

func (d NodeJSDetector) Validate(ctx context.Context) ValidationResult {
	out, err := runBounded(
		ctx,
		d.Runner,
		5*time.Second,
		"node",
		"--disable-proto=throw",
		"-e",
		"process.stdout.write('ok')",
	)
	if err != nil {
		return invalid()
	}
	return valid(d.Name(), cleanVersion(out), map[string]any{"runtime": "nodejs"})
}

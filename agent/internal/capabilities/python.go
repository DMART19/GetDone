package capabilities

import (
	"context"
	"time"
)

type PythonDetector struct{ Runner Runner }

func (PythonDetector) Name() string { return "runtime.python" }

func (d PythonDetector) Detect(ctx context.Context) Result {
	out, err := runBounded(ctx, d.Runner, 5*time.Second, "python3", "--version")
	if err != nil {
		return absent()
	}
	return detected(d.Name(), cleanVersion(out), map[string]any{"runtime": "python3"})
}

func (d PythonDetector) Validate(ctx context.Context) ValidationResult {
	out, err := runBounded(
		ctx,
		d.Runner,
		5*time.Second,
		"python3",
		"-I",
		"-c",
		"import sys; print(sys.version_info[0])",
	)
	if err != nil {
		return invalid()
	}
	return valid(d.Name(), cleanVersion(out), map[string]any{
		"runtime": "python3",
		"isolated": true,
	})
}

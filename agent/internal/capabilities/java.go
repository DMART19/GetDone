package capabilities

import (
	"context"
	"time"
)

type JavaDetector struct{ Runner Runner }

func (JavaDetector) Name() string { return "runtime.java" }

func (d JavaDetector) Detect(ctx context.Context) Result {
	out, err := runBounded(ctx, d.Runner, 5*time.Second, "java", "--version")
	if err != nil {
		out, err = runBounded(ctx, d.Runner, 5*time.Second, "java", "-version")
	}
	if err != nil {
		return absent()
	}
	return detected(d.Name(), cleanVersion(out), map[string]any{"runtime": "java"})
}

func (d JavaDetector) Validate(ctx context.Context) ValidationResult {
	out, err := runBounded(
		ctx,
		d.Runner,
		5*time.Second,
		"java",
		"-XshowSettings:vm",
		"--version",
	)
	if err != nil {
		return invalid()
	}
	return valid(d.Name(), cleanVersion(out), map[string]any{"runtime": "java"})
}

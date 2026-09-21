package capabilities

import (
	"context"
	"time"
)

type GitDetector struct{ Runner Runner }

func (GitDetector) Name() string { return "tool.git" }

func (d GitDetector) Detect(ctx context.Context) Result {
	out, err := runBounded(ctx, d.Runner, 5*time.Second, "git", "--version")
	if err != nil {
		return absent()
	}
	return detected(d.Name(), cleanVersion(out), map[string]any{"tool": "git"})
}

func (d GitDetector) Validate(ctx context.Context) ValidationResult {
	out, err := runBounded(
		ctx,
		d.Runner,
		5*time.Second,
		"git",
		"check-ref-format",
		"refs/heads/getdone-capability-probe",
	)
	if err != nil {
		return invalid()
	}
	return valid(d.Name(), cleanVersion(out), map[string]any{"tool": "git"})
}

package capabilities

import (
	"context"
	"time"
)

type FFmpegDetector struct{ Runner Runner }

func (FFmpegDetector) Name() string { return "tool.ffmpeg" }

func (d FFmpegDetector) Detect(ctx context.Context) Result {
	out, err := runBounded(ctx, d.Runner, 5*time.Second, "ffmpeg", "-version")
	if err != nil {
		return absent()
	}
	return detected(d.Name(), cleanVersion(out), map[string]any{"tool": "ffmpeg"})
}

func (d FFmpegDetector) Validate(ctx context.Context) ValidationResult {
	out, err := runBounded(
		ctx,
		d.Runner,
		8*time.Second,
		"ffmpeg",
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"color=c=black:s=2x2:d=0.01",
		"-f",
		"null",
		"-",
	)
	if err != nil {
		return invalid()
	}
	return valid(d.Name(), cleanVersion(out), map[string]any{
		"tool": "ffmpeg",
		"validation": "synthetic-frame",
	})
}

package capabilities

import (
	"context"
	"time"
)

type OllamaDetector struct{ Runner Runner }

func (OllamaDetector) Name() string { return "runtime.ollama" }

func (d OllamaDetector) Detect(ctx context.Context) Result {
	out, err := runBounded(ctx, d.Runner, 5*time.Second, "ollama", "--version")
	if err != nil {
		return absent()
	}
	return detected(d.Name(), cleanVersion(out), map[string]any{"runtime": "ollama"})
}

func (d OllamaDetector) Validate(ctx context.Context) ValidationResult {
	out, err := runBounded(ctx, d.Runner, 8*time.Second, "ollama", "list")
	if err != nil {
		return invalid()
	}
	return valid(d.Name(), cleanVersion(out), map[string]any{
		"runtime": "ollama",
		"daemonReachable": true,
	})
}

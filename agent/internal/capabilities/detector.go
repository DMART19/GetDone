package capabilities

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

type Result struct {
	Detected    bool
	Version     string
	EvidenceIDs []string
	Constraints map[string]any
}

type ValidationResult struct {
	Validated   bool
	EvidenceIDs []string
	Constraints map[string]any
}

type Detector interface {
	Name() string
	Detect(ctx context.Context) Result
	Validate(ctx context.Context) ValidationResult
}

type Runner interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

func cleanVersion(raw []byte) string {
	value := strings.TrimSpace(string(raw))
	if len(value) > 160 {
		value = value[:160]
	}
	return value
}

func evidenceID(name, stage, version string) string {
	sum := sha256.Sum256([]byte(name + ":" + stage + ":" + version))
	return "cap-evidence-" + hex.EncodeToString(sum[:12])
}

func detected(name, version string, constraints map[string]any) Result {
	if constraints == nil {
		constraints = map[string]any{}
	}
	return Result{
		Detected:    true,
		Version:     version,
		EvidenceIDs: []string{evidenceID(name, "detected", version)},
		Constraints: constraints,
	}
}

func absent() Result {
	return Result{Detected: false, EvidenceIDs: []string{}, Constraints: map[string]any{}}
}

func valid(name, version string, constraints map[string]any) ValidationResult {
	if constraints == nil {
		constraints = map[string]any{}
	}
	return ValidationResult{
		Validated:   true,
		EvidenceIDs: []string{evidenceID(name, "validated", version)},
		Constraints: constraints,
	}
}

func invalid() ValidationResult {
	return ValidationResult{Validated: false, EvidenceIDs: []string{}, Constraints: map[string]any{}}
}

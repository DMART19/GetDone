package capabilities

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/DMART19/GetDone/agent/pkg/protocol"
)

type NodeCapability struct {
	ID             string         `json:"id"`
	NodeID         string         `json:"nodeId"`
	Name           string         `json:"name"`
	Version        string         `json:"version,omitempty"`
	Status         string         `json:"status"`
	EvidenceIDs    []string       `json:"evidenceIds"`
	Constraints    map[string]any `json:"constraints"`
	ObservedAt     string         `json:"observedAt"`
	CapabilityHash string         `json:"capabilityHash"`
}

type Profile struct {
	NodeID       string           `json:"nodeId"`
	ObservedAt   string           `json:"observedAt"`
	Capabilities []NodeCapability `json:"capabilities"`
	ProfileHash  string           `json:"profileHash"`
}

type Profiler struct {
	detectors []Detector
	now       func() time.Time
}

func NewProfiler(detectors []Detector, now func() time.Time) *Profiler {
	if now == nil {
		now = time.Now
	}
	return &Profiler{detectors: append([]Detector{}, detectors...), now: now}
}

func DefaultDetectors(runner Runner) []Detector {
	return []Detector{
		DockerDetector{Runner: runner},
		ContainerdDetector{Runner: runner},
		PythonDetector{Runner: runner},
		NodeJSDetector{Runner: runner},
		JavaDetector{Runner: runner},
		GitDetector{Runner: runner},
		OllamaDetector{Runner: runner},
		CUDADetector{Runner: runner},
		FFmpegDetector{Runner: runner},
	}
}

func (p *Profiler) Profile(ctx context.Context, nodeID string) (Profile, error) {
	if strings.TrimSpace(nodeID) == "" {
		return Profile{}, fmt.Errorf("node ID is required for capability profiling")
	}
	observedAt := p.now().UTC().Format(time.RFC3339Nano)
	capabilities := make([]NodeCapability, 0, len(p.detectors))

	for _, detector := range p.detectors {
		detectedResult := detector.Detect(ctx)
		if !detectedResult.Detected {
			continue
		}
		validation := detector.Validate(ctx)
		status := "detected"
		if validation.Validated {
			status = "validated"
		}
		constraints := mergeConstraints(detectedResult.Constraints, validation.Constraints)
		evidenceIDs := uniqueStrings(append(
			append([]string{}, detectedResult.EvidenceIDs...),
			validation.EvidenceIDs...,
		))
		base := NodeCapability{
			ID:          "node-capability-" + safeCapabilityID(detector.Name()),
			NodeID:      nodeID,
			Name:        detector.Name(),
			Version:     detectedResult.Version,
			Status:      status,
			EvidenceIDs: evidenceIDs,
			Constraints: constraints,
			ObservedAt:  observedAt,
		}
		hash, err := protocol.SHA256CanonicalWithoutField(base, "capabilityHash")
		if err != nil {
			return Profile{}, fmt.Errorf("hash capability %s: %w", detector.Name(), err)
		}
		base.CapabilityHash = hash
		capabilities = append(capabilities, base)
	}

	sort.Slice(capabilities, func(i, j int) bool {
		return capabilities[i].Name < capabilities[j].Name
	})
	profile := Profile{
		NodeID:       nodeID,
		ObservedAt:   observedAt,
		Capabilities: capabilities,
	}
	hash, err := protocol.SHA256CanonicalWithoutField(profile, "profileHash")
	if err != nil {
		return Profile{}, fmt.Errorf("hash capability profile: %w", err)
	}
	profile.ProfileHash = hash
	return profile, nil
}

func mergeConstraints(values ...map[string]any) map[string]any {
	result := map[string]any{}
	for _, value := range values {
		for key, item := range value {
			result[key] = item
		}
	}
	return result
}

func uniqueStrings(values []string) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists || value == "" {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func safeCapabilityID(value string) string {
	value = strings.ReplaceAll(value, ".", "-")
	value = strings.ReplaceAll(value, "_", "-")
	return value
}

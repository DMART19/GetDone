package version

import (
	"runtime"
	"testing"
)

func TestArchitecture(t *testing.T) {
	got := Architecture()
	switch runtime.GOARCH {
	case "amd64":
		if got != "x86_64" {
			t.Fatalf("expected x86_64, got %q", got)
		}
	case "arm64":
		if got != "arm64" {
			t.Fatalf("expected arm64, got %q", got)
		}
	default:
		if got != "unsupported" {
			t.Fatalf("expected unsupported, got %q", got)
		}
	}
}

func TestVersionMetadata(t *testing.T) {
	if AgentVersion == "" || ProtocolVersion != "1.0.0" || GitCommit == "" || BuildTime == "" {
		t.Fatal("version metadata must be populated")
	}
}

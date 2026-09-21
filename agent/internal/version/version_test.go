package version

import "testing"

func TestBuildMetadataExposesProtocolAndArchitecture(t *testing.T) {
	if AgentVersion == "" {
		t.Fatal("AgentVersion must not be empty")
	}
	if ProtocolVersion != "1.0.0" {
		t.Fatalf("ProtocolVersion = %q, want 1.0.0", ProtocolVersion)
	}
	if Architecture != "amd64" && Architecture != "arm64" {
		t.Fatalf("unexpected test architecture: %s", Architecture)
	}
}

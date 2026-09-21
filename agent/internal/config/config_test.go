package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadFromFileAndEnvironmentOverrides(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{
		"controlPlaneUrl":"https://control.example.test",
		"stateDir":"/tmp/from-file",
		"logLevel":"info",
		"nodeId":"node-file",
		"enrollmentToken":"file-secret",
		"protocolVersion":"1.0.0"
	}`), 0o600); err != nil {
		t.Fatal(err)
	}

	env := map[string]string{
		"GETDONE_AGENT_STATE_DIR": "/tmp/from-env",
		"GETDONE_NODE_ID":         "node-env",
	}
	cfg, err := LoadFrom(path, func(key string) string { return env[key] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.StateDir != "/tmp/from-env" || cfg.NodeID != "node-env" {
		t.Fatalf("environment overrides not applied: %#v", cfg)
	}
	if cfg.ControlPlaneURL != "https://control.example.test" {
		t.Fatalf("unexpected control plane URL: %s", cfg.ControlPlaneURL)
	}
}

func TestLoadFromEnvironmentOnly(t *testing.T) {
	env := map[string]string{
		"GETDONE_CONTROL_PLANE_URL": "https://control.example.test",
		"GETDONE_AGENT_STATE_DIR":   t.TempDir(),
	}
	cfg, err := LoadFrom(filepath.Join(t.TempDir(), "missing.json"), func(key string) string {
		return env[key]
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ProtocolVersion != ProtocolVersion {
		t.Fatalf("expected protocol %s, got %s", ProtocolVersion, cfg.ProtocolVersion)
	}
}

func TestRedactedConfigNeverReturnsEnrollmentToken(t *testing.T) {
	cfg := Config{
		ControlPlaneURL: "https://control.example.test",
		StateDir:        "/var/lib/getdone-agent",
		LogLevel:        "info",
		EnrollmentToken: "bootstrap-token-value",
		ProtocolVersion: ProtocolVersion,
	}
	redacted := cfg.Redacted()
	if redacted.EnrollmentToken != "[REDACTED]" {
		t.Fatalf("enrollment token was not redacted: %q", redacted.EnrollmentToken)
	}
}

func TestValidationRejectsInvalidConfiguration(t *testing.T) {
	cases := []Config{
		{},
		{ControlPlaneURL: "not-a-url", StateDir: "/tmp", LogLevel: "info", ProtocolVersion: ProtocolVersion},
		{ControlPlaneURL: "https://control.example.test", StateDir: "", LogLevel: "info", ProtocolVersion: ProtocolVersion},
		{ControlPlaneURL: "https://control.example.test", StateDir: "/tmp", LogLevel: "loud", ProtocolVersion: ProtocolVersion},
		{ControlPlaneURL: "https://control.example.test", StateDir: "/tmp", LogLevel: "info", ProtocolVersion: "2.0.0"},
	}
	for index, cfg := range cases {
		if err := cfg.Validate(); err == nil {
			t.Fatalf("case %d unexpectedly validated", index)
		}
	}
}

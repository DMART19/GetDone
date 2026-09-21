package config

import (
	"strings"
	"testing"
)

func TestLoadFromEnvDefaultsAndRedaction(t *testing.T) {
	t.Setenv("GETDONE_CONTROL_PLANE_URL", "https://control.example.test")
	t.Setenv("GETDONE_STATE_DIR", "")
	t.Setenv("GETDONE_LOG_LEVEL", "")
	t.Setenv("GETDONE_NODE_ID", "node-fixture")
	t.Setenv("GETDONE_ENROLLMENT_TOKEN", "test-token")

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("LoadFromEnv failed: %v", err)
	}
	if cfg.StateDir != defaultStateDir || cfg.LogLevel != defaultLogLevel {
		t.Fatalf("defaults not applied: %+v", cfg)
	}
	if !strings.Contains(cfg.Redacted(), "[REDACTED]") {
		t.Fatal("redacted config must hide enrollment token")
	}
	if strings.Contains(cfg.Redacted(), "test-token") {
		t.Fatal("redacted config leaked enrollment token")
	}
}

func TestValidateRejectsUnsafeOrInvalidConfiguration(t *testing.T) {
	cases := []Config{
		{},
		{ControlPlaneURL: "not-a-url", StateDir: "/tmp/getdone", LogLevel: "info", ProtocolVersion: "1.0.0"},
		{ControlPlaneURL: "http://remote.example.test", StateDir: "/tmp/getdone", LogLevel: "info", ProtocolVersion: "1.0.0"},
		{ControlPlaneURL: "https://control.example.test", StateDir: "relative", LogLevel: "info", ProtocolVersion: "1.0.0"},
		{ControlPlaneURL: "https://control.example.test", StateDir: "/tmp/getdone", LogLevel: "verbose", ProtocolVersion: "1.0.0"},
		{ControlPlaneURL: "https://control.example.test", StateDir: "/tmp/getdone", LogLevel: "info", ProtocolVersion: "9.9.9"},
	}
	for i, candidate := range cases {
		if _, err := Validate(candidate); err == nil {
			t.Fatalf("case %d unexpectedly passed", i)
		}
	}
}

func TestValidateAllowsLoopbackHTTPForDevelopment(t *testing.T) {
	cfg, err := Validate(Config{
		ControlPlaneURL: "http://127.0.0.1:3000",
		StateDir:        "/tmp/getdone",
		LogLevel:        "debug",
		ProtocolVersion: "1.0.0",
	})
	if err != nil {
		t.Fatalf("loopback HTTP should be allowed: %v", err)
	}
	if cfg.ControlPlaneURL == "" {
		t.Fatal("validated config lost URL")
	}
}

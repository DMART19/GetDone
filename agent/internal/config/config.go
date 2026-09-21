package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/DMART19/GetDone/agent/internal/version"
)

const (
	defaultStateDir = "/var/lib/getdone-agent"
	defaultLogLevel = "info"
)

type Config struct {
	ControlPlaneURL string
	StateDir        string
	LogLevel        string
	NodeID          string
	EnrollmentToken string
	ProtocolVersion string
}

func LoadFromEnv() (Config, error) {
	cfg := Config{
		ControlPlaneURL: strings.TrimSpace(os.Getenv("GETDONE_CONTROL_PLANE_URL")),
		StateDir:        strings.TrimSpace(os.Getenv("GETDONE_STATE_DIR")),
		LogLevel:        strings.TrimSpace(os.Getenv("GETDONE_LOG_LEVEL")),
		NodeID:          strings.TrimSpace(os.Getenv("GETDONE_NODE_ID")),
		EnrollmentToken: strings.TrimSpace(os.Getenv("GETDONE_ENROLLMENT_TOKEN")),
		ProtocolVersion: strings.TrimSpace(os.Getenv("GETDONE_NODE_PROTOCOL_VERSION")),
	}
	if cfg.StateDir == "" {
		cfg.StateDir = defaultStateDir
	}
	if cfg.LogLevel == "" {
		cfg.LogLevel = defaultLogLevel
	}
	if cfg.ProtocolVersion == "" {
		cfg.ProtocolVersion = version.ProtocolVersion
	}
	return Validate(cfg)
}

func Validate(cfg Config) (Config, error) {
	if cfg.ControlPlaneURL == "" {
		return Config{}, errors.New("GETDONE_CONTROL_PLANE_URL is required")
	}
	parsed, err := url.Parse(cfg.ControlPlaneURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return Config{}, errors.New("GETDONE_CONTROL_PLANE_URL must be an absolute http(s) URL")
	}
	if parsed.Scheme == "http" && !isLoopbackHost(parsed.Hostname()) {
		return Config{}, errors.New("plaintext control-plane URL is allowed only for loopback development")
	}
	if !filepath.IsAbs(cfg.StateDir) {
		return Config{}, errors.New("GETDONE_STATE_DIR must be an absolute path")
	}
	switch cfg.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		return Config{}, errors.New("GETDONE_LOG_LEVEL must be debug, info, warn, or error")
	}
	if cfg.ProtocolVersion != version.ProtocolVersion {
		return Config{}, fmt.Errorf(
			"node protocol version mismatch: configured=%s supported=%s",
			cfg.ProtocolVersion,
			version.ProtocolVersion,
		)
	}
	return cfg, nil
}

func isLoopbackHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func (cfg Config) Redacted() string {
	return fmt.Sprintf(
		"controlPlaneURL=%q stateDir=%q logLevel=%q nodeID=%q protocolVersion=%q enrollmentToken=%q",
		cfg.ControlPlaneURL,
		cfg.StateDir,
		cfg.LogLevel,
		cfg.NodeID,
		cfg.ProtocolVersion,
		redact(cfg.EnrollmentToken),
	)
}

func redact(value string) string {
	if value == "" {
		return ""
	}
	return "[REDACTED]"
}

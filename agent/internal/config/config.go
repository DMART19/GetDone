package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const (
	DefaultConfigPath = "/etc/getdone-agent/config.json"
	DefaultStateDir   = "/var/lib/getdone-agent"
	DefaultLogLevel   = "info"
	ProtocolVersion   = "1.0.0"
)

type Config struct {
	ControlPlaneURL string `json:"controlPlaneUrl"`
	StateDir        string `json:"stateDir"`
	LogLevel        string `json:"logLevel"`
	NodeID          string `json:"nodeId,omitempty"`
	EnrollmentToken string `json:"enrollmentToken,omitempty"`
	ProtocolVersion string `json:"protocolVersion"`
}

type RedactedConfig struct {
	ControlPlaneURL string
	StateDir        string
	LogLevel        string
	NodeID          string
	EnrollmentToken string
	ProtocolVersion string
}

func Load() (Config, error) {
	path := strings.TrimSpace(os.Getenv("GETDONE_AGENT_CONFIG"))
	if path == "" {
		path = DefaultConfigPath
	}
	return LoadFrom(path, os.Getenv)
}

func LoadFrom(path string, getenv func(string) string) (Config, error) {
	cfg := Config{
		StateDir:        DefaultStateDir,
		LogLevel:        DefaultLogLevel,
		ProtocolVersion: ProtocolVersion,
	}

	data, err := os.ReadFile(filepath.Clean(path))
	switch {
	case err == nil:
		if err := json.Unmarshal(data, &cfg); err != nil {
			return Config{}, fmt.Errorf("decode agent config: %w", err)
		}
	case errors.Is(err, os.ErrNotExist):
		// Environment-only configuration is supported.
	default:
		return Config{}, fmt.Errorf("read agent config: %w", err)
	}

	override(&cfg.ControlPlaneURL, getenv("GETDONE_CONTROL_PLANE_URL"))
	override(&cfg.StateDir, getenv("GETDONE_AGENT_STATE_DIR"))
	override(&cfg.LogLevel, getenv("GETDONE_AGENT_LOG_LEVEL"))
	override(&cfg.NodeID, getenv("GETDONE_NODE_ID"))
	override(&cfg.EnrollmentToken, getenv("GETDONE_ENROLLMENT_TOKEN"))
	override(&cfg.ProtocolVersion, getenv("GETDONE_AGENT_PROTOCOL_VERSION"))

	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if strings.TrimSpace(c.ControlPlaneURL) == "" {
		return errors.New("control plane URL is required")
	}
	parsed, err := url.Parse(c.ControlPlaneURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return errors.New("control plane URL must be an absolute HTTP(S) URL")
	}
	if strings.TrimSpace(c.StateDir) == "" {
		return errors.New("state directory is required")
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		return errors.New("log level must be debug, info, warn, or error")
	}
	if c.ProtocolVersion != ProtocolVersion {
		return fmt.Errorf("unsupported agent protocol version %q", c.ProtocolVersion)
	}
	return nil
}

func (c Config) Redacted() RedactedConfig {
	token := ""
	if c.EnrollmentToken != "" {
		token = "[REDACTED]"
	}
	return RedactedConfig{
		ControlPlaneURL: c.ControlPlaneURL,
		StateDir: c.StateDir,
		LogLevel: c.LogLevel,
		NodeID: c.NodeID,
		EnrollmentToken: token,
		ProtocolVersion: c.ProtocolVersion,
	}
}

func override(target *string, value string) {
	if strings.TrimSpace(value) != "" {
		*target = strings.TrimSpace(value)
	}
}

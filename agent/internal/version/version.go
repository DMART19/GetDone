package version

import "runtime"

var (
	AgentVersion   = "0.1.0"
	ProtocolVersion = "1.0.0"
	GitCommit      = "development"
	BuildTime      = "unknown"
)

func Architecture() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x86_64"
	case "arm64":
		return "arm64"
	default:
		return "unsupported"
	}
}

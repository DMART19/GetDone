package version

import "runtime"

var (
	AgentVersion    = "0.3.0-development"
	ProtocolVersion = "1.0.0"
	GitCommit       = "unknown"
	BuildTime       = "unknown"
	Architecture    = runtime.GOARCH
)

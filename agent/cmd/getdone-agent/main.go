package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/DMART19/GetDone/agent/internal/agentruntime"
	"github.com/DMART19/GetDone/agent/internal/config"
	"github.com/DMART19/GetDone/agent/internal/controlplane"
	"github.com/DMART19/GetDone/agent/internal/health"
	"github.com/DMART19/GetDone/agent/internal/localstate"
	"github.com/DMART19/GetDone/agent/internal/version"
)

func main() {
	cfg, err := config.LoadFromEnv()
	if err != nil {
		log.Fatalf("configuration error: %v", err)
	}

	store, err := localstate.NewStore(cfg.StateDir)
	if err != nil {
		log.Fatalf("local state initialization error: %v", err)
	}
	state, err := store.Load(localstate.Empty(version.AgentVersion, version.ProtocolVersion))
	if err != nil {
		log.Fatalf("local state load error: %v", err)
	}
	if state.ProtocolVersion != version.ProtocolVersion {
		log.Fatalf(
			"local state protocol version %q does not match Agent protocol %q",
			state.ProtocolVersion,
			version.ProtocolVersion,
		)
	}

	client, err := controlplane.New(cfg.ControlPlaneURL)
	if err != nil {
		log.Fatalf("control-plane client initialization error: %v", err)
	}
	manager := health.New()
	runtime := agentruntime.New(manager, nil)

	log.Printf(
		"GetDone Node Agent starting version=%s protocol=%s architecture=%s controlPlane=%s config={%s}",
		version.AgentVersion,
		version.ProtocolVersion,
		version.Architecture(),
		client.BaseURL(),
		cfg.Redacted(),
	)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := runtime.Run(ctx); err != nil {
		log.Fatalf("Agent runtime stopped with error: %v", err)
	}
	log.Printf("GetDone Node Agent stopped cleanly")
}

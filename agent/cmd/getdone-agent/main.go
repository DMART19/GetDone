package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/DMART19/GetDone/agent/internal/config"
	"github.com/DMART19/GetDone/agent/internal/controlplane"
	"github.com/DMART19/GetDone/agent/internal/enrollment"
	"github.com/DMART19/GetDone/agent/internal/health"
	"github.com/DMART19/GetDone/agent/internal/localstate"
	"github.com/DMART19/GetDone/agent/internal/version"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load configuration: %v", err)
	}

	redacted, _ := json.Marshal(cfg.Redacted())
	log.Printf("starting GetDone Node Agent config=%s version=%s protocol=%s arch=%s",
		redacted,
		version.AgentVersion,
		version.ProtocolVersion,
		version.Architecture,
	)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	store := localstate.NewStore(cfg.StateDir)
	state, err := store.Load(localstate.New(version.AgentVersion, version.ProtocolVersion))
	if err != nil {
		log.Fatalf("load local state: %v", err)
	}
	if cfg.NodeID != "" && state.NodeID == "" {
		state.NodeID = cfg.NodeID
		if err := store.Save(state); err != nil {
			log.Fatalf("persist configured node identity: %v", err)
		}
	}

	client, err := controlplane.New(cfg.ControlPlaneURL)
	if err != nil {
		log.Fatalf("initialize control-plane client: %v", err)
	}
	log.Printf("control-plane endpoint initialized: %s", client.BaseURL())

	if state.NodeID == "" {
		enroller := enrollment.New(client, store, cfg.StateDir, config.Path())
		state, err = enroller.Enroll(
			ctx,
			state,
			version.AgentVersion,
			version.ProtocolVersion,
			cfg.EnrollmentToken,
		)
		if err != nil {
			log.Fatalf("enroll Node Agent: %v", err)
		}
		log.Printf("Node Agent enrollment completed nodeId=%s", state.NodeID)
	}

	manager := health.NewManager(time.Now())
	if err := manager.Run(ctx); err != nil {
		log.Fatalf("agent runtime: %v", err)
	}
	log.Printf("GetDone Node Agent stopped cleanly")
}

package agentruntime

import (
	"context"
	"time"

	"github.com/DMART19/GetDone/agent/internal/health"
)

type Runtime struct {
	health *health.Manager
	now    func() time.Time
}

func New(manager *health.Manager, now func() time.Time) *Runtime {
	if now == nil {
		now = time.Now
	}
	return &Runtime{health: manager, now: now}
}

func (r *Runtime) Run(ctx context.Context) error {
	r.health.Start(r.now())
	defer r.health.Stop(r.now())
	<-ctx.Done()
	return nil
}

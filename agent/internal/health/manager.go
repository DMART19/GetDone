package health

import (
	"context"
	"sync"
	"time"
)

type Snapshot struct {
	StartedAt time.Time
	Ready     bool
}

type Manager struct {
	mu        sync.RWMutex
	startedAt time.Time
	ready     bool
}

func NewManager(now time.Time) *Manager {
	return &Manager{startedAt: now.UTC()}
}

func (m *Manager) Run(ctx context.Context) error {
	m.mu.Lock()
	m.ready = true
	m.mu.Unlock()

	<-ctx.Done()

	m.mu.Lock()
	m.ready = false
	m.mu.Unlock()
	return nil
}

func (m *Manager) Snapshot() Snapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return Snapshot{StartedAt: m.startedAt, Ready: m.ready}
}

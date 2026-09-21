package health

import (
	"sync"
	"time"
)

type Snapshot struct {
	Started   bool
	StartedAt time.Time
	StoppedAt time.Time
}

type Manager struct {
	mu        sync.RWMutex
	started   bool
	startedAt time.Time
	stoppedAt time.Time
}

func New() *Manager {
	return &Manager{}
}

func (m *Manager) Start(now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.started {
		return
	}
	m.started = true
	m.startedAt = now.UTC()
	m.stoppedAt = time.Time{}
}

func (m *Manager) Stop(now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.started {
		return
	}
	m.started = false
	m.stoppedAt = now.UTC()
}

func (m *Manager) Snapshot() Snapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return Snapshot{
		Started:   m.started,
		StartedAt: m.startedAt,
		StoppedAt: m.stoppedAt,
	}
}

package agentruntime

import (
	"context"
	"testing"
	"time"

	"github.com/DMART19/GetDone/agent/internal/health"
)

func TestRuntimeStopsCleanlyOnContextCancellation(t *testing.T) {
	manager := health.New()
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	runtime := New(manager, func() time.Time { return now })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runtime.Run(ctx) }()

	deadline := time.After(time.Second)
	for !manager.Snapshot().Started {
		select {
		case <-deadline:
			t.Fatal("runtime did not start")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("runtime returned error: %v", err)
	}
	if manager.Snapshot().Started {
		t.Fatal("health manager must stop after cancellation")
	}
}

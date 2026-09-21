package health

import (
	"testing"
	"time"
)

func TestManagerLifecycle(t *testing.T) {
	manager := New()
	start := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	stop := start.Add(time.Minute)
	manager.Start(start)
	manager.Start(start.Add(time.Second))
	if snapshot := manager.Snapshot(); !snapshot.Started || !snapshot.StartedAt.Equal(start) {
		t.Fatalf("unexpected started snapshot: %+v", snapshot)
	}
	manager.Stop(stop)
	if snapshot := manager.Snapshot(); snapshot.Started || !snapshot.StoppedAt.Equal(stop) {
		t.Fatalf("unexpected stopped snapshot: %+v", snapshot)
	}
}

package health

import (
	"context"
	"testing"
	"time"
)

func TestManagerStopsCleanlyWhenContextIsCancelled(t *testing.T) {
	manager := NewManager(time.Unix(100, 0))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)

	go func() {
		done <- manager.Run(ctx)
	}()

	deadline := time.Now().Add(time.Second)
	for !manager.Snapshot().Ready && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !manager.Snapshot().Ready {
		t.Fatal("manager never became ready")
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("manager did not stop after cancellation")
	}
	if manager.Snapshot().Ready {
		t.Fatal("manager remained ready after shutdown")
	}
}

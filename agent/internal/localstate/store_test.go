package localstate

import (
	"os"
	"strings"
	"testing"
)

func TestAtomicSaveAndLoad(t *testing.T) {
	store := NewStore(t.TempDir())
	state := New("0.1.0", "1.0.0")
	state.NodeID = "node-1"
	state.ActiveJobIDs = []string{"job-1"}
	state.ActiveReservationIDs = []string{"reservation-1"}

	if err := store.Save(state); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(store.Path())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("state permissions = %o, want 600", info.Mode().Perm())
	}

	loaded, err := store.Load(New("other", "1.0.0"))
	if err != nil {
		t.Fatal(err)
	}
	if loaded.NodeID != "node-1" || len(loaded.ActiveJobIDs) != 1 {
		t.Fatalf("unexpected loaded state: %#v", loaded)
	}

	entries, err := os.ReadDir(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".state-") {
			t.Fatalf("temporary state file was not cleaned up: %s", entry.Name())
		}
	}
}

func TestMissingStateReturnsValidatedDefault(t *testing.T) {
	store := NewStore(t.TempDir())
	expected := New("0.1.0", "1.0.0")
	got, err := store.Load(expected)
	if err != nil {
		t.Fatal(err)
	}
	if got.AgentVersion != expected.AgentVersion {
		t.Fatalf("unexpected default state: %#v", got)
	}
}

func TestInvalidStateRejected(t *testing.T) {
	store := NewStore(t.TempDir())
	if err := store.Save(State{SchemaVersion: 999}); err == nil {
		t.Fatal("invalid state unexpectedly saved")
	}

	if err := os.WriteFile(store.Path(), []byte(`{"schemaVersion":999}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(New("0.1.0", "1.0.0")); err == nil {
		t.Fatal("invalid persisted state unexpectedly loaded")
	}
}

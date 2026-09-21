package localstate

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSaveLoadUsesAtomicProtectedStateFile(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	state := Empty("0.1.0", "1.0.0")
	state.NodeID = "node-1"
	state.ActiveJobIDs = []string{"job-1"}
	state.ActiveReservationIDs = []string{"reservation-1"}
	now := time.Now().UTC().Truncate(time.Second)
	state.LastControlPlaneContactAt = &now

	if err := store.Save(state); err != nil {
		t.Fatalf("save failed: %v", err)
	}
	loaded, err := store.Load(Empty("ignored", "1.0.0"))
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if loaded.NodeID != "node-1" || len(loaded.ActiveJobIDs) != 1 {
		t.Fatalf("state did not round trip: %+v", loaded)
	}

	info, err := os.Stat(filepath.Join(dir, stateFileName))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("state file permissions too broad: %o", info.Mode().Perm())
	}
	matches, err := filepath.Glob(filepath.Join(dir, ".state-*.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("temporary files were not cleaned up: %v", matches)
	}
}

func TestLoadMissingReturnsValidatedDefault(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	expected := Empty("0.1.0", "1.0.0")
	got, err := store.Load(expected)
	if err != nil {
		t.Fatal(err)
	}
	if got.StateVersion != CurrentStateVersion || got.AgentVersion != "0.1.0" {
		t.Fatalf("unexpected default state: %+v", got)
	}
}

func TestValidateRejectsCorruptOrAmbiguousState(t *testing.T) {
	now := time.Now().UTC()
	cases := []State{
		{},
		{StateVersion: CurrentStateVersion, AgentVersion: "0.1.0", ProtocolVersion: "1.0.0", ActiveJobIDs: []string{"job-1", "job-1"}},
		{StateVersion: CurrentStateVersion, AgentVersion: "0.1.0", ProtocolVersion: "1.0.0", ActiveReservationIDs: []string{""}},
		{StateVersion: CurrentStateVersion, AgentVersion: "0.1.0", ProtocolVersion: "1.0.0", PendingResults: []PendingResult{{JobID: "job-1", ResultID: "result-1", CreatedAt: now}}},
	}
	for i, state := range cases {
		if err := Validate(state); err == nil {
			t.Fatalf("case %d unexpectedly validated", i)
		}
	}
}

func TestLoadRejectsUnknownFields(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{"stateVersion":1,"agentVersion":"0.1.0","protocolVersion":"1.0.0","unknown":true}`)
	if err := os.WriteFile(filepath.Join(dir, stateFileName), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(Empty("0.1.0", "1.0.0")); err == nil {
		t.Fatal("unknown fields must fail closed")
	}
}

func TestNewStoreRequiresAbsolutePath(t *testing.T) {
	if _, err := NewStore("relative/path"); err == nil {
		t.Fatal("relative local state path must be rejected")
	}
}

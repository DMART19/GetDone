package protocol

import "testing"

func TestCanonicalHashMatchesControlPlaneOrdering(t *testing.T) {
	got, err := SHA256Canonical(map[string]any{"b": 2, "a": 1})
	if err != nil {
		t.Fatal(err)
	}
	const expected = "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
	if got != expected {
		t.Fatalf("canonical hash = %s, want %s", got, expected)
	}
}

package capabilities

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeRunner struct {
	results map[string]struct {
		out []byte
		err error
	}
}

func (r *fakeRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	key := name + " " + strings.Join(args, " ")
	result, ok := r.results[key]
	if !ok {
		return nil, errors.New("unavailable")
	}
	return result.out, result.err
}

func success(out string) struct {
	out []byte
	err error
} {
	return struct {
		out []byte
		err error
	}{out: []byte(out)}
}

func failure() struct {
	out []byte
	err error
} {
	return struct {
		out []byte
		err error
	}{err: errors.New("probe failed")}
}

func TestDetectedCapabilityCanRemainUnvalidated(t *testing.T) {
	runner := &fakeRunner{results: map[string]struct {
		out []byte
		err error
	}{
		"docker --version": success("Docker version 28.0.0"),
		"docker run --rm --pull=never --network=none --read-only --cap-drop=ALL --pids-limit=16 --memory=32m --cpus=0.25 busybox:latest true": failure(),
	}}
	profile, err := NewProfiler(
		[]Detector{DockerDetector{Runner: runner}},
		func() time.Time { return time.Unix(100, 0) },
	).Profile(context.Background(), "node-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(profile.Capabilities) != 1 {
		t.Fatalf("capabilities = %#v", profile.Capabilities)
	}
	capability := profile.Capabilities[0]
	if capability.Status != "detected" || capability.Version != "Docker version 28.0.0" {
		t.Fatalf("unexpected detected-only capability: %#v", capability)
	}
}

func TestSuccessfulValidationCapturesRuntimeVersions(t *testing.T) {
	runner := &fakeRunner{results: map[string]struct {
		out []byte
		err error
	}{
		"python3 --version": success("Python 3.12.7"),
		"python3 -I -c import sys; print(sys.version_info[0])": success("3"),
		"node --version": success("v24.8.0"),
		"node --disable-proto=throw -e process.stdout.write('ok')": success("ok"),
	}}
	profile, err := NewProfiler(
		[]Detector{
			PythonDetector{Runner: runner},
			NodeJSDetector{Runner: runner},
		},
		func() time.Time { return time.Unix(100, 0) },
	).Profile(context.Background(), "node-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(profile.Capabilities) != 2 {
		t.Fatalf("capability count = %d", len(profile.Capabilities))
	}
	for _, capability := range profile.Capabilities {
		if capability.Status != "validated" || capability.Version == "" {
			t.Fatalf("unexpected validated capability: %#v", capability)
		}
		if len(capability.CapabilityHash) != 64 {
			t.Fatalf("invalid capability hash: %#v", capability)
		}
	}
	if len(profile.ProfileHash) != 64 {
		t.Fatalf("invalid profile hash: %s", profile.ProfileHash)
	}
}

func TestCUDAAbsentAndDockerUnavailableAreNotAdvertised(t *testing.T) {
	runner := &fakeRunner{results: map[string]struct {
		out []byte
		err error
	}{}}
	profile, err := NewProfiler(
		[]Detector{
			CUDADetector{Runner: runner},
			DockerDetector{Runner: runner},
		},
		func() time.Time { return time.Unix(100, 0) },
	).Profile(context.Background(), "node-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(profile.Capabilities) != 0 {
		t.Fatalf("unexpected absent capabilities: %#v", profile.Capabilities)
	}
}

func TestValidationFailureDoesNotBecomeValidated(t *testing.T) {
	runner := &fakeRunner{results: map[string]struct {
		out []byte
		err error
	}{
		"ollama --version": success("ollama version 0.12.0"),
		"ollama list": failure(),
	}}
	profile, err := NewProfiler(
		[]Detector{OllamaDetector{Runner: runner}},
		func() time.Time { return time.Unix(100, 0) },
	).Profile(context.Background(), "node-1")
	if err != nil {
		t.Fatal(err)
	}
	if profile.Capabilities[0].Status != "detected" {
		t.Fatalf("failed validation was promoted: %#v", profile.Capabilities[0])
	}
}

func TestSaveProfileUsesProtectedAtomicSnapshot(t *testing.T) {
	dir := t.TempDir()
	profile := Profile{
		NodeID: "node-1",
		ObservedAt: time.Unix(100, 0).UTC().Format(time.RFC3339),
		Capabilities: []NodeCapability{},
		ProfileHash: strings.Repeat("a", 64),
	}
	if err := SaveProfile(dir, profile); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, snapshotFileName)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("profile permissions = %o", info.Mode().Perm())
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".capabilities-") {
			t.Fatalf("temporary profile leaked: %s", entry.Name())
		}
	}
}

func TestDefaultDetectorNamesAreUnique(t *testing.T) {
	runner := &fakeRunner{results: map[string]struct {
		out []byte
		err error
	}{}}
	seen := map[string]bool{}
	for _, detector := range DefaultDetectors(runner) {
		if seen[detector.Name()] {
			t.Fatalf("duplicate detector %s", detector.Name())
		}
		seen[detector.Name()] = true
	}
	if len(seen) != 9 {
		t.Fatalf("default detector count = %d", len(seen))
	}
}

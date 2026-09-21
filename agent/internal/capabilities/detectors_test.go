package capabilities

import (
	"context"
	"testing"
)

func TestRemainingInitialDetectorsValidate(t *testing.T) {
	runner := &fakeRunner{results: map[string]struct {
		out []byte
		err error
	}{
		"ctr version": success("Client:\n  Version: 2.0.0"),
		"ctr plugins ls": success("TYPE ID PLATFORM STATUS"),
		"java --version": success("openjdk 21.0.4"),
		"java -XshowSettings:vm --version": success("openjdk 21.0.4"),
		"git --version": success("git version 2.47.0"),
		"git check-ref-format refs/heads/getdone-capability-probe": success(""),
		"ffmpeg -version": success("ffmpeg version 7.0"),
		"ffmpeg -v error -f lavfi -i color=c=black:s=2x2:d=0.01 -f null -": success(""),
		"nvidia-smi --query-gpu=driver_version --format=csv,noheader": success("570.1"),
		"nvidia-smi --query-gpu=index,compute_cap --format=csv,noheader,nounits": success("0, 8.9"),
	}}

	detectors := []Detector{
		ContainerdDetector{Runner: runner},
		JavaDetector{Runner: runner},
		GitDetector{Runner: runner},
		FFmpegDetector{Runner: runner},
		CUDADetector{Runner: runner},
	}

	for _, detector := range detectors {
		t.Run(detector.Name(), func(t *testing.T) {
			detected := detector.Detect(context.Background())
			if !detected.Detected || detected.Version == "" {
				t.Fatalf("detector did not capture version: %#v", detected)
			}
			validated := detector.Validate(context.Background())
			if !validated.Validated {
				t.Fatalf("detector did not validate: %#v", validated)
			}
		})
	}
}

func TestDockerValidationRequiresSandboxedContainerSuccess(t *testing.T) {
	runner := &fakeRunner{results: map[string]struct {
		out []byte
		err error
	}{
		"docker --version": success("Docker version 28.0.0"),
		"docker run --rm --pull=never --network=none --read-only --cap-drop=ALL --pids-limit=16 --memory=32m --cpus=0.25 busybox:latest true": success(""),
	}}
	detector := DockerDetector{Runner: runner}
	if !detector.Detect(context.Background()).Detected {
		t.Fatal("Docker was not detected")
	}
	if !detector.Validate(context.Background()).Validated {
		t.Fatal("sandboxed Docker validation did not succeed")
	}
}

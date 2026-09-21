package localstate

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const stateFileName = "state.json"

type Store struct {
	dir  string
	path string
}

func NewStore(dir string) (*Store, error) {
	if !filepath.IsAbs(dir) {
		return nil, errors.New("local state directory must be absolute")
	}
	return &Store{dir: dir, path: filepath.Join(dir, stateFileName)}, nil
}

func (s *Store) Load(defaultState State) (State, error) {
	file, err := os.Open(s.path)
	if errors.Is(err, os.ErrNotExist) {
		if err := Validate(defaultState); err != nil {
			return State{}, err
		}
		return defaultState, nil
	}
	if err != nil {
		return State{}, fmt.Errorf("open local state: %w", err)
	}
	defer file.Close()

	decoder := json.NewDecoder(io.LimitReader(file, 4<<20))
	decoder.DisallowUnknownFields()
	var state State
	if err := decoder.Decode(&state); err != nil {
		return State{}, fmt.Errorf("decode local state: %w", err)
	}
	if err := Validate(state); err != nil {
		return State{}, err
	}
	return state, nil
}

func (s *Store) Save(state State) error {
	if err := Validate(state); err != nil {
		return err
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return fmt.Errorf("create local state directory: %w", err)
	}

	temp, err := os.CreateTemp(s.dir, ".state-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary state: %w", err)
	}
	tempPath := temp.Name()
	cleanup := func() {
		_ = temp.Close()
		_ = os.Remove(tempPath)
	}
	if err := temp.Chmod(0o600); err != nil {
		cleanup()
		return fmt.Errorf("secure temporary state: %w", err)
	}

	encoder := json.NewEncoder(temp)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(state); err != nil {
		cleanup()
		return fmt.Errorf("encode temporary state: %w", err)
	}
	if err := temp.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("fsync temporary state: %w", err)
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempPath)
		return fmt.Errorf("close temporary state: %w", err)
	}
	if err := os.Rename(tempPath, s.path); err != nil {
		_ = os.Remove(tempPath)
		return fmt.Errorf("atomically replace local state: %w", err)
	}
	if err := syncDirectory(s.dir); err != nil {
		return err
	}
	return nil
}

func syncDirectory(dir string) error {
	handle, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("open state directory for fsync: %w", err)
	}
	defer handle.Close()
	if err := handle.Sync(); err != nil {
		return fmt.Errorf("fsync state directory: %w", err)
	}
	return nil
}

func Validate(state State) error {
	if state.StateVersion != CurrentStateVersion {
		return fmt.Errorf("unsupported local state version %d", state.StateVersion)
	}
	if state.AgentVersion == "" || state.ProtocolVersion == "" {
		return errors.New("local state requires agent and protocol versions")
	}
	if duplicate(state.ActiveJobIDs) {
		return errors.New("local state contains duplicate active Job IDs")
	}
	if duplicate(state.ActiveReservationIDs) {
		return errors.New("local state contains duplicate active reservation IDs")
	}
	seenResults := map[string]struct{}{}
	for _, result := range state.PendingResults {
		if result.JobID == "" || result.ResultID == "" || result.PayloadPath == "" || result.CreatedAt.IsZero() {
			return errors.New("pending result is incomplete")
		}
		if _, ok := seenResults[result.ResultID]; ok {
			return errors.New("local state contains duplicate pending result IDs")
		}
		seenResults[result.ResultID] = struct{}{}
	}
	return nil
}

func duplicate(values []string) bool {
	seen := map[string]struct{}{}
	for _, value := range values {
		if value == "" {
			return true
		}
		if _, ok := seen[value]; ok {
			return true
		}
		seen[value] = struct{}{}
	}
	return false
}

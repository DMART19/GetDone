package localstate

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const stateFileName = "state.json"

type Store struct {
	dir string
}

func NewStore(dir string) *Store {
	return &Store{dir: filepath.Clean(dir)}
}

func (s *Store) Path() string {
	return filepath.Join(s.dir, stateFileName)
}

func (s *Store) Load(defaultState State) (State, error) {
	data, err := os.ReadFile(s.Path())
	if errors.Is(err, os.ErrNotExist) {
		if err := defaultState.Validate(); err != nil {
			return State{}, err
		}
		return defaultState, nil
	}
	if err != nil {
		return State{}, fmt.Errorf("read local state: %w", err)
	}
	var state State
	if err := json.Unmarshal(data, &state); err != nil {
		return State{}, fmt.Errorf("decode local state: %w", err)
	}
	if err := state.Validate(); err != nil {
		return State{}, fmt.Errorf("validate local state: %w", err)
	}
	return state, nil
}

func (s *Store) Save(state State) error {
	if err := state.Validate(); err != nil {
		return err
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return fmt.Errorf("create state directory: %w", err)
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
	defer cleanup()

	if err := temp.Chmod(0o600); err != nil {
		return fmt.Errorf("protect temporary state: %w", err)
	}
	encoder := json.NewEncoder(temp)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(state); err != nil {
		return fmt.Errorf("encode temporary state: %w", err)
	}
	if err := temp.Sync(); err != nil {
		return fmt.Errorf("fsync temporary state: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close temporary state: %w", err)
	}
	if err := os.Rename(tempPath, s.Path()); err != nil {
		return fmt.Errorf("atomically replace state: %w", err)
	}

	dir, err := os.Open(s.dir)
	if err != nil {
		return fmt.Errorf("open state directory for fsync: %w", err)
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return fmt.Errorf("fsync state directory: %w", err)
	}
	return nil
}

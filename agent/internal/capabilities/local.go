package capabilities

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const snapshotFileName = "capability-profile.json"

func SaveProfile(stateDir string, profile Profile) error {
	dir := filepath.Clean(stateDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create capability state directory: %w", err)
	}
	temp, err := os.CreateTemp(dir, ".capabilities-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary capability profile: %w", err)
	}
	tempPath := temp.Name()
	defer func() {
		_ = temp.Close()
		_ = os.Remove(tempPath)
	}()
	if err := temp.Chmod(0o600); err != nil {
		return fmt.Errorf("protect temporary capability profile: %w", err)
	}
	encoder := json.NewEncoder(temp)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(profile); err != nil {
		return fmt.Errorf("encode capability profile: %w", err)
	}
	if err := temp.Sync(); err != nil {
		return fmt.Errorf("fsync capability profile: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close capability profile: %w", err)
	}
	if err := os.Rename(tempPath, filepath.Join(dir, snapshotFileName)); err != nil {
		return fmt.Errorf("atomically replace capability profile: %w", err)
	}
	return nil
}

package inventory

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const snapshotFileName = "hardware-inventory.json"

func SnapshotPath(stateDir string) string {
	return filepath.Join(filepath.Clean(stateDir), snapshotFileName)
}

func SaveSnapshot(stateDir string, inventory HardwareInventory) error {
	dir := filepath.Clean(stateDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create inventory state directory: %w", err)
	}
	temp, err := os.CreateTemp(dir, ".inventory-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary inventory snapshot: %w", err)
	}
	tempPath := temp.Name()
	defer func() {
		_ = temp.Close()
		_ = os.Remove(tempPath)
	}()
	if err := temp.Chmod(0o600); err != nil {
		return fmt.Errorf("protect temporary inventory snapshot: %w", err)
	}
	encoder := json.NewEncoder(temp)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(inventory); err != nil {
		return fmt.Errorf("encode inventory snapshot: %w", err)
	}
	if err := temp.Sync(); err != nil {
		return fmt.Errorf("fsync inventory snapshot: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close inventory snapshot: %w", err)
	}
	if err := os.Rename(tempPath, SnapshotPath(dir)); err != nil {
		return fmt.Errorf("atomically replace inventory snapshot: %w", err)
	}
	return nil
}

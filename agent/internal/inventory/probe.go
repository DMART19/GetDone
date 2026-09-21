package inventory

import (
	"context"
	"os"
	"os/exec"
	"syscall"
)

type FilesystemStats struct {
	TotalBytes     uint64
	AvailableBytes uint64
}

type Probe interface {
	ReadFile(path string) ([]byte, error)
	ReadDir(path string) ([]os.DirEntry, error)
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
	StatFS(path string) (FilesystemStats, error)
}

type LinuxProbe struct{}

func (LinuxProbe) ReadFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}

func (LinuxProbe) ReadDir(path string) ([]os.DirEntry, error) {
	return os.ReadDir(path)
}

func (LinuxProbe) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).Output()
}

func (LinuxProbe) StatFS(path string) (FilesystemStats, error) {
	var stats syscall.Statfs_t
	if err := syscall.Statfs(path, &stats); err != nil {
		return FilesystemStats{}, err
	}
	blockSize := uint64(stats.Bsize)
	return FilesystemStats{
		TotalBytes:     uint64(stats.Blocks) * blockSize,
		AvailableBytes: uint64(stats.Bavail) * blockSize,
	}, nil
}

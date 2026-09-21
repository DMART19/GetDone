package enrollment

import (
	"os"
)

type IdentityFiles struct {
	CertificatePath string
	PrivateKeyPath  string
	ChainPath       string
}

func (f IdentityFiles) ValidatePermissions() error {
	for _, item := range []string{f.CertificatePath, f.PrivateKeyPath, f.ChainPath} {
		info, err := os.Stat(item)
		if err != nil {
			return err
		}
		if info.Mode().Perm()&0o077 != 0 {
			return &PermissionError{Path: item, Mode: info.Mode().Perm()}
		}
	}
	return nil
}

type PermissionError struct {
	Path string
	Mode os.FileMode
}

func (e *PermissionError) Error() string {
	return "node identity file permissions are too broad"
}

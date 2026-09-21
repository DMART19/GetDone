package enrollment

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/DMART19/GetDone/agent/internal/config"
	"github.com/DMART19/GetDone/agent/internal/localstate"
)

type fakePoster struct {
	response    apiEnvelope
	lastPath    string
	lastRequest EnrollRequest
	err         error
}

func (f *fakePoster) PostJSON(
	_ context.Context,
	path string,
	requestValue any,
	responseValue any,
) error {
	if f.err != nil {
		return f.err
	}
	f.lastPath = path
	f.lastRequest = requestValue.(EnrollRequest)
	target := responseValue.(*apiEnvelope)
	*target = f.response
	return nil
}

func successEnvelope() apiEnvelope {
	var data bootstrapData
	data.NodeID = "node-1"
	data.CredentialID = "credential-1"
	data.IdentityCertificate = "certificate"
	data.CertificateChain = "chain"
	data.ControlPlaneIdentity.NodeID = "node-1"
	data.ControlPlaneIdentity.PortfolioID = "portfolio-a"
	data.ControlPlaneIdentity.CompanyID = "company-a"
	data.Configuration.ProtocolVersion = "1.0.0"
	return apiEnvelope{OK: true, Data: data}
}

func writeConfig(t *testing.T, dir string, token string) string {
	t.Helper()
	path := filepath.Join(dir, "config.json")
	data, err := json.Marshal(config.Config{
		ControlPlaneURL: "https://control.example.test",
		StateDir:        dir,
		LogLevel:        "info",
		EnrollmentToken: token,
		ProtocolVersion: "1.0.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestEnrollmentPersistsIdentityAndErasesBootstrapToken(t *testing.T) {
	dir := t.TempDir()
	token := "bootstrap-token-that-is-long-enough"
	configPath := writeConfig(t, dir, token)
	store := localstate.NewStore(dir)
	state := localstate.New("0.1.0", "1.0.0")
	poster := &fakePoster{response: successEnvelope()}
	client := New(poster, store, dir, configPath)

	next, err := client.Enroll(
		context.Background(),
		state,
		"0.1.0",
		"1.0.0",
		token,
	)
	if err != nil {
		t.Fatal(err)
	}
	if next.NodeID != "node-1" {
		t.Fatalf("node ID = %q", next.NodeID)
	}
	if poster.lastPath != "/api/agent/v1/enroll" {
		t.Fatalf("unexpected enrollment path %s", poster.lastPath)
	}
	if poster.lastRequest.EnrollmentToken != token {
		t.Fatal("bootstrap token was not sent")
	}
	for _, path := range []string{
		next.PrivateKeyReference,
		next.CertificateReference,
		filepath.Join(dir, "identity-ca.crt.pem"),
	} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s permissions = %o", path, info.Mode().Perm())
		}
	}
	reloaded, err := store.Load(localstate.New("other", "1.0.0"))
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.NodeID != "node-1" {
		t.Fatalf("identity did not survive restart: %#v", reloaded)
	}
	cfg, err := config.LoadFrom(configPath, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.EnrollmentToken != "" {
		t.Fatal("bootstrap token remained in config after enrollment")
	}
}

func TestEnrollmentRejectsMismatchedServerIdentity(t *testing.T) {
	dir := t.TempDir()
	response := successEnvelope()
	response.Data.ControlPlaneIdentity.NodeID = "other-node"
	client := New(
		&fakePoster{response: response},
		localstate.NewStore(dir),
		dir,
		writeConfig(t, dir, "bootstrap-token-that-is-long-enough"),
	)
	_, err := client.Enroll(
		context.Background(),
		localstate.New("0.1.0", "1.0.0"),
		"0.1.0",
		"1.0.0",
		"bootstrap-token-that-is-long-enough",
	)
	if err == nil {
		t.Fatal("mismatched server identity was accepted")
	}
}

func TestEnrollmentRejectsMissingCertificateMaterial(t *testing.T) {
	dir := t.TempDir()
	response := successEnvelope()
	response.Data.IdentityCertificate = ""
	client := New(
		&fakePoster{response: response},
		localstate.NewStore(dir),
		dir,
		writeConfig(t, dir, "bootstrap-token-that-is-long-enough"),
	)
	_, err := client.Enroll(
		context.Background(),
		localstate.New("0.1.0", "1.0.0"),
		"0.1.0",
		"1.0.0",
		"bootstrap-token-that-is-long-enough",
	)
	if err == nil {
		t.Fatal("missing certificate material was accepted")
	}
}

func TestExistingIdentitySkipsEnrollment(t *testing.T) {
	dir := t.TempDir()
	state := localstate.New("0.1.0", "1.0.0")
	state.NodeID = "node-existing"
	poster := &fakePoster{response: successEnvelope()}
	client := New(poster, localstate.NewStore(dir), dir, filepath.Join(dir, "missing.json"))
	next, err := client.Enroll(context.Background(), state, "0.1.0", "1.0.0", "")
	if err != nil {
		t.Fatal(err)
	}
	if next.NodeID != "node-existing" || poster.lastPath != "" {
		t.Fatal("existing identity unexpectedly re-enrolled")
	}
}

func TestArchitectureMapping(t *testing.T) {
	if got, err := protocolArchitecture("amd64"); err != nil || got != "x86_64" {
		t.Fatalf("amd64 mapping = %q, %v", got, err)
	}
	if got, err := protocolArchitecture("arm64"); err != nil || got != "arm64" {
		t.Fatalf("arm64 mapping = %q, %v", got, err)
	}
	if _, err := protocolArchitecture("riscv64"); err == nil {
		t.Fatal("unsupported architecture unexpectedly mapped")
	}
}

package enrollment

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/DMART19/GetDone/agent/internal/config"
	"github.com/DMART19/GetDone/agent/internal/localstate"
)

type Poster interface {
	PostJSON(ctx context.Context, path string, requestValue any, responseValue any) error
}

type Client struct {
	controlPlane Poster
	stateStore   *localstate.Store
	stateDir     string
	configPath   string
}

type EnrollRequest struct {
	EnrollmentToken    string `json:"enrollmentToken"`
	AgentVersion       string `json:"agentVersion"`
	ProtocolVersion    string `json:"protocolVersion"`
	Architecture       string `json:"architecture"`
	BootstrapPublicKey string `json:"bootstrapPublicKey"`
	Nonce              string `json:"nonce"`
}

type bootstrapData struct {
	NodeID               string `json:"nodeId"`
	CredentialID         string `json:"credentialId"`
	IdentityCertificate  string `json:"identityCertificate"`
	CertificateChain     string `json:"certificateChain"`
	ControlPlaneIdentity struct {
		NodeID      string `json:"nodeId"`
		PortfolioID string `json:"portfolioId"`
		CompanyID   string `json:"companyId"`
	} `json:"controlPlaneIdentity"`
	Configuration struct {
		ProtocolVersion string `json:"protocolVersion"`
	} `json:"configuration"`
	Replay bool `json:"replay"`
}

type apiEnvelope struct {
	OK    bool          `json:"ok"`
	Data  bootstrapData `json:"data"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func New(
	controlPlane Poster,
	stateStore *localstate.Store,
	stateDir string,
	configPath string,
) *Client {
	return &Client{
		controlPlane: controlPlane,
		stateStore:   stateStore,
		stateDir:     filepath.Clean(stateDir),
		configPath:   filepath.Clean(configPath),
	}
}

func (c *Client) Enroll(
	ctx context.Context,
	state localstate.State,
	agentVersion string,
	protocolVersion string,
	enrollmentToken string,
) (localstate.State, error) {
	if strings.TrimSpace(state.NodeID) != "" {
		return state, nil
	}
	if strings.TrimSpace(enrollmentToken) == "" {
		return state, errors.New("node enrollment token is required when no identity exists")
	}
	architecture, err := protocolArchitecture(runtime.GOARCH)
	if err != nil {
		return state, err
	}

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return state, fmt.Errorf("generate bootstrap keypair: %w", err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return state, fmt.Errorf("marshal bootstrap public key: %w", err)
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return state, fmt.Errorf("marshal bootstrap private key: %w", err)
	}
	publicPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER})
	privatePEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER})

	nonceBytes := make([]byte, 24)
	if _, err := rand.Read(nonceBytes); err != nil {
		return state, fmt.Errorf("generate enrollment nonce: %w", err)
	}

	request := EnrollRequest{
		EnrollmentToken:    enrollmentToken,
		AgentVersion:       agentVersion,
		ProtocolVersion:    protocolVersion,
		Architecture:       architecture,
		BootstrapPublicKey: string(publicPEM),
		Nonce:              base64.RawURLEncoding.EncodeToString(nonceBytes),
	}
	var response apiEnvelope
	if err := c.controlPlane.PostJSON(ctx, "/api/agent/v1/enroll", request, &response); err != nil {
		return state, err
	}
	if !response.OK {
		if response.Error != nil {
			return state, fmt.Errorf("enrollment rejected: %s: %s", response.Error.Code, response.Error.Message)
		}
		return state, errors.New("enrollment rejected without an error envelope")
	}
	if err := validateBootstrapResponse(response.Data, protocolVersion); err != nil {
		return state, err
	}

	if err := os.MkdirAll(c.stateDir, 0o700); err != nil {
		return state, fmt.Errorf("create identity directory: %w", err)
	}
	keyPath := filepath.Join(c.stateDir, "identity.key.pem")
	certPath := filepath.Join(c.stateDir, "identity.crt.pem")
	chainPath := filepath.Join(c.stateDir, "identity-ca.crt.pem")

	if err := writeAtomic(keyPath, privatePEM, 0o600); err != nil {
		return state, err
	}
	if err := writeAtomic(certPath, []byte(response.Data.IdentityCertificate), 0o600); err != nil {
		_ = os.Remove(keyPath)
		return state, err
	}
	if err := writeAtomic(chainPath, []byte(response.Data.CertificateChain), 0o600); err != nil {
		_ = os.Remove(keyPath)
		_ = os.Remove(certPath)
		return state, err
	}

	next := state
	next.NodeID = response.Data.NodeID
	next.CertificateReference = certPath
	next.CertificateChainReference = chainPath
	next.PrivateKeyReference = keyPath
	next.ProtocolVersion = response.Data.Configuration.ProtocolVersion
	if err := c.stateStore.Save(next); err != nil {
		_ = os.Remove(keyPath)
		_ = os.Remove(certPath)
		_ = os.Remove(chainPath)
		return state, fmt.Errorf("persist enrolled identity state: %w", err)
	}
	if err := config.EraseEnrollmentToken(c.configPath); err != nil {
		return state, fmt.Errorf("erase bootstrap token after enrollment: %w", err)
	}
	return next, nil
}

func validateBootstrapResponse(data bootstrapData, protocolVersion string) error {
	if strings.TrimSpace(data.NodeID) == "" || strings.TrimSpace(data.CredentialID) == "" {
		return errors.New("enrollment response is missing node or credential identity")
	}
	if data.ControlPlaneIdentity.NodeID != data.NodeID {
		return errors.New("enrollment response control-plane node identity mismatch")
	}
	if strings.TrimSpace(data.ControlPlaneIdentity.PortfolioID) == "" ||
		strings.TrimSpace(data.ControlPlaneIdentity.CompanyID) == "" {
		return errors.New("enrollment response is missing control-plane scope")
	}
	if strings.TrimSpace(data.IdentityCertificate) == "" ||
		strings.TrimSpace(data.CertificateChain) == "" {
		return errors.New("enrollment response is missing identity certificate material")
	}
	if data.Configuration.ProtocolVersion != protocolVersion {
		return errors.New("enrollment response protocol version mismatch")
	}
	return nil
}

func protocolArchitecture(goarch string) (string, error) {
	switch goarch {
	case "amd64":
		return "x86_64", nil
	case "arm64":
		return "arm64", nil
	default:
		return "", fmt.Errorf("unsupported Node Agent architecture %q", goarch)
	}
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, ".identity-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary identity file: %w", err)
	}
	tempPath := temp.Name()
	defer func() {
		_ = temp.Close()
		_ = os.Remove(tempPath)
	}()
	if err := temp.Chmod(mode); err != nil {
		return fmt.Errorf("protect temporary identity file: %w", err)
	}
	if _, err := temp.Write(data); err != nil {
		return fmt.Errorf("write temporary identity file: %w", err)
	}
	if err := temp.Sync(); err != nil {
		return fmt.Errorf("fsync temporary identity file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close temporary identity file: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("atomically replace identity file: %w", err)
	}
	return nil
}

package localstate

import (
	"errors"
	"strings"
	"time"
)

const SchemaVersion = 1

type PendingResult struct {
	JobID      string    `json:"jobId"`
	ResultPath string    `json:"resultPath"`
	RecordedAt time.Time `json:"recordedAt"`
}

type State struct {
	SchemaVersion             int             `json:"schemaVersion"`
	NodeID                    string          `json:"nodeId,omitempty"`
	CertificateReference      string          `json:"certificateReference,omitempty"`
	CertificateChainReference string          `json:"certificateChainReference,omitempty"`
	PrivateKeyReference       string          `json:"privateKeyReference,omitempty"`
	AgentVersion              string          `json:"agentVersion"`
	ProtocolVersion           string          `json:"protocolVersion"`
	LastHeartbeatSequence     uint64          `json:"lastHeartbeatSequence"`
	ActiveJobIDs              []string        `json:"activeJobIds"`
	ActiveReservationIDs      []string        `json:"activeReservationIds"`
	PendingResults            []PendingResult `json:"pendingResults"`
	LastControlPlaneContactAt *time.Time      `json:"lastControlPlaneContactAt,omitempty"`
}

func New(agentVersion, protocolVersion string) State {
	return State{
		SchemaVersion:        SchemaVersion,
		AgentVersion:         agentVersion,
		ProtocolVersion:      protocolVersion,
		ActiveJobIDs:         []string{},
		ActiveReservationIDs: []string{},
		PendingResults:       []PendingResult{},
	}
}

func (s State) Validate() error {
	if s.SchemaVersion != SchemaVersion {
		return errors.New("unsupported local state schema version")
	}
	if strings.TrimSpace(s.AgentVersion) == "" {
		return errors.New("local state agent version is required")
	}
	if strings.TrimSpace(s.ProtocolVersion) == "" {
		return errors.New("local state protocol version is required")
	}
	for _, id := range append(append([]string{}, s.ActiveJobIDs...), s.ActiveReservationIDs...) {
		if strings.TrimSpace(id) == "" {
			return errors.New("local state contains an empty active identifier")
		}
	}
	for _, result := range s.PendingResults {
		if strings.TrimSpace(result.JobID) == "" || strings.TrimSpace(result.ResultPath) == "" {
			return errors.New("pending result requires job ID and result path")
		}
	}
	return nil
}

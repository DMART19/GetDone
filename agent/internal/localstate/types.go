package localstate

import "time"

const CurrentStateVersion = 1

type PendingResult struct {
	JobID       string    `json:"jobId"`
	ResultID    string    `json:"resultId"`
	CreatedAt   time.Time `json:"createdAt"`
	PayloadPath string    `json:"payloadPath"`
}

type State struct {
	StateVersion              int             `json:"stateVersion"`
	NodeID                    string          `json:"nodeId,omitempty"`
	CertificateReference      string          `json:"certificateReference,omitempty"`
	LastHeartbeatSequence     uint64          `json:"lastHeartbeatSequence"`
	ActiveJobIDs              []string        `json:"activeJobIds"`
	ActiveReservationIDs      []string        `json:"activeReservationIds"`
	PendingResults            []PendingResult `json:"pendingResults"`
	AgentVersion              string          `json:"agentVersion"`
	ProtocolVersion           string          `json:"protocolVersion"`
	LastControlPlaneContactAt *time.Time      `json:"lastControlPlaneContactAt,omitempty"`
}

func Empty(agentVersion, protocolVersion string) State {
	return State{
		StateVersion:         CurrentStateVersion,
		ActiveJobIDs:         []string{},
		ActiveReservationIDs: []string{},
		PendingResults:       []PendingResult{},
		AgentVersion:         agentVersion,
		ProtocolVersion:      protocolVersion,
	}
}

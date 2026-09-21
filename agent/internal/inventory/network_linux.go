package inventory

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

type ipAddressInfo struct {
	Local     string `json:"local"`
	PrefixLen int    `json:"prefixlen"`
}

type ipInterface struct {
	IfName    string          `json:"ifname"`
	Address   string          `json:"address"`
	MTU       int             `json:"mtu"`
	OperState string          `json:"operstate"`
	AddrInfo  []ipAddressInfo `json:"addr_info"`
}

func DiscoverNetwork(ctx context.Context, probe Probe) ([]NetworkInterface, error) {
	output, err := probe.Run(ctx, "ip", "-json", "address", "show")
	if err != nil {
		return []NetworkInterface{}, nil
	}
	var interfaces []ipInterface
	if err := json.Unmarshal(output, &interfaces); err != nil {
		return nil, err
	}

	result := make([]NetworkInterface, 0, len(interfaces))
	for _, item := range interfaces {
		if item.IfName == "" || item.IfName == "lo" {
			continue
		}
		addresses := make([]string, 0, len(item.AddrInfo))
		for _, address := range item.AddrInfo {
			if strings.TrimSpace(address.Local) == "" {
				continue
			}
			addresses = append(addresses, fmt.Sprintf("%s/%d", address.Local, address.PrefixLen))
		}
		sort.Strings(addresses)

		speed := float64(0)
		if raw, readErr := probe.ReadFile("/sys/class/net/" + item.IfName + "/speed"); readErr == nil {
			if value, parseErr := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64); parseErr == nil && value > 0 {
				speed = value
			}
		}
		state := strings.ToLower(item.OperState)
		if state != "up" && state != "down" {
			state = "unknown"
		}
		macHash := ""
		if item.Address != "" {
			sum := sha256.Sum256([]byte(strings.ToLower(item.Address)))
			macHash = hex.EncodeToString(sum[:])
		}
		result = append(result, NetworkInterface{
			ID:            "net-" + shortHash(item.IfName),
			Name:          item.IfName,
			MACHash:       macHash,
			Addresses:     addresses,
			MTU:           item.MTU,
			LinkState:     state,
			LinkSpeedMbps: speed,
		})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Name < result[j].Name
	})
	return result, nil
}

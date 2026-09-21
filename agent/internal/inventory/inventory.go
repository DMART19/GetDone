package inventory

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/DMART19/GetDone/agent/pkg/protocol"
)

type Collector struct {
	probe  Probe
	goarch string
	now    func() time.Time
}

func NewCollector(probe Probe, goarch string, now func() time.Time) *Collector {
	if now == nil {
		now = time.Now
	}
	return &Collector{probe: probe, goarch: goarch, now: now}
}

func (c *Collector) Collect(ctx context.Context, nodeID string) (HardwareInventory, error) {
	if strings.TrimSpace(nodeID) == "" {
		return HardwareInventory{}, fmt.Errorf("node ID is required for hardware inventory")
	}
	cpu, err := DiscoverCPU(ctx, c.probe, c.goarch)
	if err != nil {
		return HardwareInventory{}, err
	}
	memory, err := DiscoverMemory(c.probe)
	if err != nil {
		return HardwareInventory{}, err
	}
	storage, err := DiscoverStorage(ctx, c.probe)
	if err != nil {
		return HardwareInventory{}, err
	}
	network, err := DiscoverNetwork(ctx, c.probe)
	if err != nil {
		return HardwareInventory{}, err
	}
	operatingSystem, err := DiscoverOS(ctx, c.probe)
	if err != nil {
		return HardwareInventory{}, err
	}
	gpus, err := DiscoverGPUs(ctx, c.probe)
	if err != nil {
		return HardwareInventory{}, err
	}

	inventory := HardwareInventory{
		NodeID:          nodeID,
		Platform:        "linux",
		Architecture:    cpu.Architecture,
		CPU:             cpu,
		Memory:          memory,
		GPUs:            gpus,
		Storage:         storage,
		Network:         network,
		OperatingSystem: operatingSystem,
		Cgroups:         DiscoverCgroups(c.probe),
		DiscoveredAt:    c.now().UTC().Format(time.RFC3339Nano),
	}
	hash, err := protocol.SHA256CanonicalWithoutField(inventory, "inventoryHash")
	if err != nil {
		return HardwareInventory{}, fmt.Errorf("hash hardware inventory: %w", err)
	}
	inventory.InventoryHash = hash
	return inventory, nil
}

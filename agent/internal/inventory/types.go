package inventory

type CPUInventory struct {
	Architecture            string  `json:"architecture"`
	Vendor                  string  `json:"vendor,omitempty"`
	Model                   string  `json:"model"`
	Sockets                 int     `json:"sockets"`
	PhysicalCores           int     `json:"physicalCores"`
	LogicalThreads          int     `json:"logicalThreads"`
	FrequencyMHz            float64 `json:"frequencyMHz,omitempty"`
	VirtualizationSupported bool    `json:"virtualizationSupported"`
}

type MemoryInventory struct {
	TotalBytes uint64 `json:"totalBytes"`
	NUMANodes  int    `json:"numaNodes,omitempty"`
}

type GPUDevice struct {
	ID                  string   `json:"id"`
	Vendor              string   `json:"vendor"`
	Model               string   `json:"model"`
	MemoryBytes         uint64   `json:"memoryBytes,omitempty"`
	ComputeCapabilities []string `json:"computeCapabilities"`
	DriverVersion       string   `json:"driverVersion,omitempty"`
	CUDAVersion         string   `json:"cudaVersion,omitempty"`
	ROCMVersion         string   `json:"rocmVersion,omitempty"`
	Health              string   `json:"health"`
}

type StorageDevice struct {
	ID             string `json:"id"`
	Device         string `json:"device"`
	Mount          string `json:"mount,omitempty"`
	Filesystem     string `json:"filesystem,omitempty"`
	TotalBytes     uint64 `json:"totalBytes"`
	AvailableBytes uint64 `json:"availableBytes"`
	Rotational     bool   `json:"rotational"`
	Removable      bool   `json:"removable"`
	NVMe           bool   `json:"nvme"`
}

type NetworkInterface struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	MACHash       string   `json:"macHash,omitempty"`
	Addresses     []string `json:"addresses"`
	MTU           int      `json:"mtu,omitempty"`
	LinkState     string   `json:"linkState"`
	LinkSpeedMbps float64  `json:"linkSpeedMbps,omitempty"`
}

type OSInventory struct {
	Distribution string `json:"distribution"`
	Version      string `json:"version"`
	Kernel       string `json:"kernel"`
}

type CgroupInventory struct {
	Version   int  `json:"version"`
	Available bool `json:"available"`
}

type HardwareInventory struct {
	NodeID          string             `json:"nodeId"`
	Platform        string             `json:"platform"`
	Architecture    string             `json:"architecture"`
	CPU             CPUInventory       `json:"cpu"`
	Memory          MemoryInventory    `json:"memory"`
	GPUs            []GPUDevice        `json:"gpus"`
	Storage         []StorageDevice    `json:"storage"`
	Network         []NetworkInterface `json:"network"`
	OperatingSystem OSInventory        `json:"operatingSystem"`
	Cgroups         CgroupInventory    `json:"cgroups"`
	DiscoveredAt    string             `json:"discoveredAt"`
	InventoryHash   string             `json:"inventoryHash"`
}

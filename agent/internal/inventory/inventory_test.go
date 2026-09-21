package inventory

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"strings"
	"testing"
	"time"
)

type fakeDirEntry struct {
	name string
	dir  bool
}

func (e fakeDirEntry) Name() string               { return e.name }
func (e fakeDirEntry) IsDir() bool                { return e.dir }
func (e fakeDirEntry) Type() fs.FileMode          { if e.dir { return fs.ModeDir }; return 0 }
func (e fakeDirEntry) Info() (fs.FileInfo, error) { return nil, errors.New("not implemented") }

type fakeProbe struct {
	files map[string][]byte
	dirs  map[string][]os.DirEntry
	runs  map[string][]byte
	stats map[string]FilesystemStats
}

func (p *fakeProbe) ReadFile(path string) ([]byte, error) {
	if value, ok := p.files[path]; ok {
		return value, nil
	}
	return nil, os.ErrNotExist
}

func (p *fakeProbe) ReadDir(path string) ([]os.DirEntry, error) {
	if value, ok := p.dirs[path]; ok {
		return value, nil
	}
	return nil, os.ErrNotExist
}

func (p *fakeProbe) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	key := name + " " + strings.Join(args, " ")
	if value, ok := p.runs[key]; ok {
		return value, nil
	}
	return nil, errors.New("command unavailable")
}

func (p *fakeProbe) StatFS(path string) (FilesystemStats, error) {
	if value, ok := p.stats[path]; ok {
		return value, nil
	}
	return FilesystemStats{}, os.ErrNotExist
}

func baseProbe(cpuInfo string) *fakeProbe {
	return &fakeProbe{
		files: map[string][]byte{
			"/proc/cpuinfo": []byte(cpuInfo),
			"/sys/devices/system/cpu/online": []byte("0-3\n"),
			"/proc/meminfo": []byte("MemTotal:       16384000 kB\n"),
			"/etc/os-release": []byte("NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\n"),
			"/sys/fs/cgroup/cgroup.controllers": []byte("cpu memory pids\n"),
		},
		dirs: map[string][]os.DirEntry{
			"/sys/devices/system/node": {
				fakeDirEntry{name: "node0", dir: true},
			},
		},
		runs: map[string][]byte{
			"uname -r": []byte("6.8.0-test\n"),
			"lsblk -J -b -o NAME,KNAME,PATH,MOUNTPOINTS,FSTYPE,SIZE,ROTA,RM,TYPE": []byte(`{"blockdevices":[]}`),
			"ip -json address show": []byte(`[]`),
		},
		stats: map[string]FilesystemStats{},
	}
}

const intelCPU = `processor : 0
vendor_id : GenuineIntel
model name : Intel(R) Xeon(R)
physical id : 0
core id : 0
cpu MHz : 3000.000
flags : fpu vmx

processor : 1
vendor_id : GenuineIntel
model name : Intel(R) Xeon(R)
physical id : 0
core id : 1
flags : fpu vmx

processor : 2
vendor_id : GenuineIntel
model name : Intel(R) Xeon(R)
physical id : 0
core id : 0
flags : fpu vmx

processor : 3
vendor_id : GenuineIntel
model name : Intel(R) Xeon(R)
physical id : 0
core id : 1
flags : fpu vmx
`

const amdCPU = `processor : 0
vendor_id : AuthenticAMD
model name : AMD EPYC
physical id : 0
core id : 0
flags : fpu svm

processor : 1
vendor_id : AuthenticAMD
model name : AMD EPYC
physical id : 1
core id : 0
flags : fpu svm
`

const armPiCPU = `processor : 0
model name : ARMv8 Processor rev 1 (v8l)
Features : fp asimd
CPU implementer : 0x41
Hardware : BCM2712

processor : 1
model name : ARMv8 Processor rev 1 (v8l)
Features : fp asimd
CPU implementer : 0x41
Hardware : BCM2712
`

const armServerCPU = `processor : 0
model name : Neoverse-N1
Features : fp asimd
CPU implementer : 0x41

processor : 1
model name : Neoverse-N1
Features : fp asimd
CPU implementer : 0x41

processor : 2
model name : Neoverse-N1
Features : fp asimd
CPU implementer : 0x41

processor : 3
model name : Neoverse-N1
Features : fp asimd
CPU implementer : 0x41
`

func TestCPUDiscoveryIntelAMDAndARM64Fixtures(t *testing.T) {
	tests := []struct {
		name string
		cpu string
		arch string
		wantArch string
		wantModel string
	}{
		{"intel-x86", intelCPU, "amd64", "x86_64", "Intel(R) Xeon(R)"},
		{"amd-x86", amdCPU, "amd64", "x86_64", "AMD EPYC"},
		{"pi-like-arm64", armPiCPU, "arm64", "arm64", "ARMv8 Processor rev 1 (v8l)"},
		{"server-arm64", armServerCPU, "arm64", "arm64", "Neoverse-N1"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			probe := baseProbe(test.cpu)
			if test.name == "amd-x86" {
				probe.files["/sys/devices/system/cpu/online"] = []byte("0-1\n")
			}
			cpu, err := DiscoverCPU(context.Background(), probe, test.arch)
			if err != nil {
				t.Fatal(err)
			}
			if cpu.Architecture != test.wantArch || cpu.Model != test.wantModel {
				t.Fatalf("unexpected CPU: %#v", cpu)
			}
		})
	}
}

func TestMemoryDiscoveryARMServerNUMA(t *testing.T) {
	probe := baseProbe(armServerCPU)
	probe.dirs["/sys/devices/system/node"] = []os.DirEntry{
		fakeDirEntry{name: "node0", dir: true},
		fakeDirEntry{name: "node1", dir: true},
	}
	memory, err := DiscoverMemory(probe)
	if err != nil {
		t.Fatal(err)
	}
	if memory.NUMANodes != 2 || memory.TotalBytes != 16384000*1024 {
		t.Fatalf("unexpected memory: %#v", memory)
	}
}

func TestStorageDiscoveryMultipleDisksAndMountRedaction(t *testing.T) {
	probe := baseProbe(intelCPU)
	probe.runs["lsblk -J -b -o NAME,KNAME,PATH,MOUNTPOINTS,FSTYPE,SIZE,ROTA,RM,TYPE"] = []byte(`{
	  "blockdevices": [
	    {"name":"nvme0n1","kname":"nvme0n1","path":"/dev/nvme0n1","mountpoints":[null],"fstype":"","size":1000000,"rota":false,"rm":false,"type":"disk",
	      "children":[{"name":"nvme0n1p1","kname":"nvme0n1p1","path":"/dev/nvme0n1p1","mountpoints":["/"],"fstype":"ext4","size":900000,"rota":false,"rm":false,"type":"part"}]},
	    {"name":"sdb","kname":"sdb","path":"/dev/sdb","mountpoints":["/mnt/customer-alpha"],"fstype":"xfs","size":2000000,"rota":true,"rm":false,"type":"disk"}
	  ]
	}`)
	probe.stats["/"] = FilesystemStats{TotalBytes: 900000, AvailableBytes: 450000}
	probe.stats["/mnt/customer-alpha"] = FilesystemStats{TotalBytes: 2000000, AvailableBytes: 1500000}
	storage, err := DiscoverStorage(context.Background(), probe)
	if err != nil {
		t.Fatal(err)
	}
	if len(storage) != 3 {
		t.Fatalf("expected three normalized block records, got %d", len(storage))
	}
	foundRedacted := false
	for _, item := range storage {
		if item.Mount == "/mnt/[redacted]" {
			foundRedacted = true
		}
		if strings.Contains(item.Mount, "customer-alpha") {
			t.Fatal("sensitive mount component leaked into inventory")
		}
	}
	if !foundRedacted {
		t.Fatal("expected nested /mnt mount to be redacted")
	}
}

func TestNetworkDiscoveryHashesMACAndDoesNotRequireLogging(t *testing.T) {
	probe := baseProbe(intelCPU)
	probe.runs["ip -json address show"] = []byte(`[
	  {"ifname":"lo","address":"00:00:00:00:00:00","mtu":65536,"operstate":"UNKNOWN","addr_info":[{"local":"127.0.0.1","prefixlen":8}]},
	  {"ifname":"eth0","address":"aa:bb:cc:dd:ee:ff","mtu":1500,"operstate":"UP","addr_info":[{"local":"10.0.0.10","prefixlen":24}]}
	]`)
	probe.files["/sys/class/net/eth0/speed"] = []byte("10000\n")
	network, err := DiscoverNetwork(context.Background(), probe)
	if err != nil {
		t.Fatal(err)
	}
	if len(network) != 1 || network[0].Name != "eth0" || len(network[0].MACHash) != 64 {
		t.Fatalf("unexpected network inventory: %#v", network)
	}
	if network[0].LinkSpeedMbps != 10000 {
		t.Fatalf("unexpected link speed: %v", network[0].LinkSpeedMbps)
	}
}

func TestNVIDIAAndNoGPUFixtures(t *testing.T) {
	probe := baseProbe(intelCPU)
	probe.runs["nvidia-smi --query-gpu=index,name,memory.total,driver_version --format=csv,noheader,nounits"] =
		[]byte("0, NVIDIA RTX 6000 Ada, 49140, 570.1\n")
	probe.runs["nvidia-smi --query-gpu=index,compute_cap --format=csv,noheader,nounits"] =
		[]byte("0, 8.9\n")
	gpus, err := DiscoverGPUs(context.Background(), probe)
	if err != nil {
		t.Fatal(err)
	}
	if len(gpus) != 1 || gpus[0].Vendor != "nvidia" || gpus[0].MemoryBytes == 0 {
		t.Fatalf("unexpected NVIDIA inventory: %#v", gpus)
	}

	noGPU := baseProbe(intelCPU)
	none, err := DiscoverGPUs(context.Background(), noGPU)
	if err != nil {
		t.Fatal(err)
	}
	if len(none) != 0 {
		t.Fatalf("expected no GPUs, got %#v", none)
	}
}

func TestCollectorHandlesContainerVMAndPhysicalHostFixtures(t *testing.T) {
	vm := baseProbe(intelCPU)
	vm.files["/etc/os-release"] = []byte("NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\n")
	vm.files["/sys/fs/cgroup/cgroup.controllers"] = []byte("cpu memory\n")
	collector := NewCollector(vm, "amd64", func() time.Time {
		return time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	})
	inventory, err := collector.Collect(context.Background(), "node-vm")
	if err != nil {
		t.Fatal(err)
	}
	if inventory.Architecture != "x86_64" || inventory.Cgroups.Version != 2 || len(inventory.InventoryHash) != 64 {
		t.Fatalf("unexpected VM inventory: %#v", inventory)
	}

	physical := baseProbe(armServerCPU)
	physical.files["/sys/devices/system/cpu/online"] = []byte("0-3\n")
	delete(physical.files, "/sys/fs/cgroup/cgroup.controllers")
	physical.dirs["/sys/fs/cgroup"] = []os.DirEntry{fakeDirEntry{name: "cpu", dir: true}}
	physicalCollector := NewCollector(physical, "arm64", func() time.Time {
		return time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	})
	host, err := physicalCollector.Collect(context.Background(), "node-arm-server")
	if err != nil {
		t.Fatal(err)
	}
	if host.Architecture != "arm64" || host.Cgroups.Version != 1 || !host.Cgroups.Available {
		t.Fatalf("unexpected physical host inventory: %#v", host)
	}
}

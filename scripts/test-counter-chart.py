"""Check bounded Standard selector rendering without changing host access."""
import json
from pathlib import Path
import re
import subprocess
import tempfile

chart = Path(__file__).resolve().parent.parent / "deploy/helm/jood-monitor"
base = {"image": {"digest": "sha256:" + "a" * 64}, "hubURL": "https://monitor.example.com"}


def render(node):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "values.json"
        path.write_text(json.dumps({**base, "node": node}))
        return subprocess.run(
            ["helm", "template", "monitor", str(chart), "--namespace", "jood-monitor", "--values", str(path)],
            capture_output=True, text=True, check=False,
        )


def selection_pattern(name):
    return rf"(name: {name}\s+value: )([^\n]+)"


empty = render({})
assert empty.returncode == 0, empty.stderr
configured = render({"standardNetworkInterfaces": ["eth0", "enp7s0", "enp8s0"], "standardDiskDevices": ["sda"]})
assert configured.returncode == 0, configured.stderr
normalized = configured.stdout
for name, expected in {
    "JOOD_STANDARD_NETWORK_INTERFACES": ["eth0", "enp7s0", "enp8s0"],
    "JOOD_STANDARD_DISK_DEVICES": ["sda"],
}.items():
    pattern = selection_pattern(name)
    defaults = re.findall(pattern, empty.stdout)
    selected = re.findall(pattern, configured.stdout)
    assert len(defaults) == len(selected) == 1, name
    assert json.loads(json.loads(defaults[0][1])) == [], name
    assert json.loads(json.loads(selected[0][1])) == expected, name
    normalized = re.sub(pattern, lambda match: match[1] + defaults[0][1], normalized)
assert normalized == empty.stdout, "counter selection changed other resources, mounts, RBAC or security context"

for property_name in ["standardNetworkInterfaces", "standardDiskDevices"]:
    for invalid in [[f"device{i}" for i in range(17)], ["../host"], ["x" * 65], ["eth0", "eth0"]]:
        assert render({property_name: invalid}).returncode != 0, f"unbounded/invalid {property_name} accepted"
print("counter selections render as bounded JSON; defaults omit counters; schema rejects invalid names and bounds; host access unchanged")

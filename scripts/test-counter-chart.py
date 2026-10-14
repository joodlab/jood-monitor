"""Check bounded agent settings without changing resource budgets or access."""
import json
from pathlib import Path
import re
import subprocess
import tempfile

chart = Path(__file__).resolve().parent.parent / "deploy/helm/jood-monitor"
base = {"image": {"digest": "sha256:" + "a" * 64}, "hubURL": "https://monitor.example.com"}


def render(node, spool=None):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "values.json"
        values = {**base, "node": node}
        if spool is not None:
            values["observer"] = {"spool": spool}
        path.write_text(json.dumps(values))
        return subprocess.run(
            ["helm", "template", "monitor", str(chart), "--namespace", "jood-monitor", "--values", str(path)],
            capture_output=True, text=True, encoding="utf-8", check=False,
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

larger = render({}, {"maxBytes": 33554432, "volumeSizeMiB": 48})
assert larger.returncode == 0, larger.stderr
assert 'JOOD_SPOOL_MAX_BYTES, value: "8388608"' in empty.stdout
assert 'emptyDir: {sizeLimit: "12Mi"}' in empty.stdout
assert 'JOOD_SPOOL_MAX_BYTES, value: "33554432"' in larger.stdout
assert 'emptyDir: {sizeLimit: "48Mi"}' in larger.stdout
normalized = larger.stdout.replace('JOOD_SPOOL_MAX_BYTES, value: "33554432"', 'JOOD_SPOOL_MAX_BYTES, value: "8388608"')
normalized = normalized.replace('emptyDir: {sizeLimit: "48Mi"}', 'emptyDir: {sizeLimit: "12Mi"}')
assert normalized == empty.stdout, "spool settings changed CPU/memory, identity, mounts, RBAC or security context"
for invalid in [
    {"maxBytes": 8388607},
    {"maxBytes": 268435457, "volumeSizeMiB": 512},
    {"maxBytes": 33554432.5, "volumeSizeMiB": 48},
    {"maxBytes": 33554432, "volumeSizeMiB": 32},
    {"maxBytes": 33554432, "volumeSizeMiB": 1025},
]:
    assert render({}, invalid).returncode != 0, "invalid spool limit or volume headroom accepted"
print("spool quota/volume render independently; invalid limits and insufficient headroom fail; other resources unchanged")

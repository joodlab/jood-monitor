"""Consume the Worker export fixture with an independent OpenMetrics parser."""
import sys
from pathlib import Path

from prometheus_client.openmetrics.parser import text_string_to_metric_families

families = list(text_string_to_metric_families(Path(sys.argv[1]).read_text()))
assert {f.name for f in families} == {"system_cpu_time", "system_memory_usage"}
counter = next(f for f in families if f.type == "counter")
assert len(counter.samples) == 1
sample = counter.samples[0]
assert sample.name == "system_cpu_time_total"
assert sample.labels["cpu"] == "7"
assert sample.labels["state"] == 'user\nquoted"\\'
assert sample.value == 9007199254740993
print("independent OpenMetrics parser accepted contiguous families, escaped/typed labels and latest samples")

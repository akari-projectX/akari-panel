#!/usr/bin/env bash
# Validate the shipped monitoring config (W17): Prometheus rules (syntax +
# promtool unit tests) and the Grafana dashboards (JSON, every metric they
# query is one the panel exports). Needs docker. `make monitoring-check`.
set -euo pipefail
cd "$(dirname "$0")/.."
PROM_IMAGE=${PROM_IMAGE:-prom/prometheus:v3.15.0}
docker run --rm -v "$PWD/deploy/prometheus:/p:ro" -w /p --entrypoint promtool "$PROM_IMAGE" check rules alerts.yml
docker run --rm -v "$PWD/deploy/prometheus:/p:ro" -w /p --entrypoint promtool "$PROM_IMAGE" test rules alerts_test.yml
python3 - <<'PY'
import glob, json, re, sys
exported = set(re.findall(r'"(akari_[a-z0-9_]+)"', open("src/metrics.rs").read()))
bad = []
def strip(m):  # histogram/counter series suffixes
    for s in ("_bucket", "_count", "_sum"):
        if m.endswith(s) and m[: -len(s)] in exported:
            return m[: -len(s)]
    return m
for f in sorted(glob.glob("deploy/grafana/*.json")) + ["deploy/prometheus/alerts.yml"]:
    text = open(f).read()
    if f.endswith(".json"):
        d = json.loads(text)
        text = " ".join(t["expr"] for p in d["panels"] for t in p.get("targets", []))
    for m in sorted(set(re.findall(r"\b(akari_[a-z0-9_]+)", text))):
        if strip(m) not in exported:
            bad.append(f"{f}: {m}")
if bad:
    sys.exit("unknown metrics:\n  " + "\n  ".join(bad))
print("dashboards and rules reference exported metrics only")
PY

#!/usr/bin/env python3
"""Set the blocking perf budgets from green CI runs.

usage: scripts/perf-budget.py perf-budget.json perf1.json [perf2.json ...]
(perf*.json = the `admin-perf` artifact's perf.json of each run)

Each budget becomes min(plan target, ceil10(max median over the runs x 1.3)).
The plan targets live under "targets" (copied from the budgets the first
time); the budgets the spec reads are "desktop" / "phone". Sets
"blocking": true.
"""
import json
import math
import sys

budget_path, *runs_paths = sys.argv[1:]
with open(budget_path) as f:
    budget = json.load(f)
runs = []
for p in runs_paths:
    with open(p) as f:
        runs.append(json.load(f))
targets = budget.setdefault("targets", {"desktop": dict(budget["desktop"]), "phone": dict(budget["phone"])})
for env in ("desktop", "phone"):
    for metric, target in targets[env].items():
        medians = [r["median"] for run in runs for r in run if r["env"] == env and r["metric"] == metric]
        if not medians:
            continue
        new = min(target, int(math.ceil(max(medians) * 1.3 / 10) * 10))
        print(env, metric, medians, target, "->", new)
        budget[env][metric] = new
budget["blocking"] = True
with open(budget_path, "w") as f:
    json.dump(budget, f, indent=2)
    f.write("\n")

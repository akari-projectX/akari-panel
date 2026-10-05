#!/usr/bin/env python3
"""Billing-core line coverage gate (ROADMAP §0: "计费核心路径覆盖率 ≥ 90%").

Reads an lcov file produced by `cargo llvm-cov` (unit + real-database
tests) and reports line coverage of the billing-core modules, counting
production code only: an inline `#[cfg(test)] mod … {` block at column 0
ends a file's production code (test helpers are not product lines).
Exits non-zero when any module is below its threshold.

    cargo llvm-cov --locked --lcov --output-path target/cov.lcov
    scripts/coverage-gate.py target/cov.lcov

Thresholds are per module and only ever go up; a drop fails CI.
"""

import os
import re
import sys

# Billing core: traffic accounting and flush, enforcement, entitlement
# (who may use which node), plan assignment/renewal, orders (payment ->
# fulfilment), catalog (prices, upgrade/renewal decisions), the payment
# notify handler and Alipay verification.
MODULES = {
    "src/traffic.rs": 90.0,
    "src/enforce.rs": 90.0,
    "src/entitle.rs": 90.0,
    "src/plans.rs": 90.0,
    "src/billing/orders.rs": 90.0,
    "src/billing/catalog.rs": 90.0,
    "src/billing/api.rs": 90.0,
    "src/billing/alipay.rs": 90.0,
    "src/billing/methods.rs": 90.0,
    # W16: coupons, balance ledger, invite commission + withdrawals.
    "src/billing/coupons.rs": 90.0,
    "src/billing/ledger.rs": 90.0,
    "src/billing/commission.rs": 90.0,
    # W17: tickets (permissions, limits) and node alerts (evaluator, delivery).
    "src/tickets.rs": 90.0,
    "src/alerts/mod.rs": 90.0,
    "src/alerts/eval.rs": 90.0,
    "src/alerts/channels.rs": 90.0,
    # W22: traffic history (query parser, the four endpoints).
    "src/trafficlog.rs": 90.0,
    # Ops: batch user actions, CSV exports, manual orders, batch coupons.
    "src/batch.rs": 90.0,
    "src/export.rs": 90.0,
    "src/csvx.rs": 90.0,
    "src/billing/manual.rs": 90.0,
    "src/billing/coupon_batches.rs": 90.0,
    # W27: bot protection of the public forms (tokens, honeypot, Turnstile).
    "src/botguard.rs": 90.0,
}

TEST_MOD = re.compile(r"^(pub(\(crate\))? )?mod \w+ \{")


def production_end(path):
    """First line number of the inline test module (or a huge number)."""
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    for i, line in enumerate(lines):
        if line.strip() == "#[cfg(test)]" and i + 1 < len(lines) and TEST_MOD.match(lines[i + 1]):
            return i + 1  # 1-based number of the attribute line
    return 1 << 30


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    root = os.getcwd()
    hits = {}  # module -> {line: count}
    current = None
    with open(sys.argv[1], encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if line.startswith("SF:"):
                p = os.path.relpath(line[3:], root)
                current = p if p in MODULES else None
                if current:
                    hits.setdefault(current, {})
            elif line.startswith("DA:") and current:
                n, c = line[3:].split(",")[:2]
                n, c = int(n), int(c)
                d = hits[current]
                d[n] = max(d.get(n, 0), c)
            elif line == "end_of_record":
                current = None
    failed = False
    print(f"{'module':<26}{'lines':>8}{'covered':>9}{'cover':>9}{'min':>7}")
    for mod, minimum in MODULES.items():
        if mod not in hits:
            print(f"{mod:<26} missing from the coverage report")
            failed = True
            continue
        end = production_end(mod)
        prod = {n: c for n, c in hits[mod].items() if n < end}
        total = len(prod)
        covered = sum(1 for c in prod.values() if c > 0)
        pct = 100.0 * covered / total if total else 100.0
        bad = pct < minimum
        failed |= bad
        print(f"{mod:<26}{total:>8}{covered:>9}{pct:>8.2f}%{minimum:>6.0f}%{'  FAIL' if bad else ''}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

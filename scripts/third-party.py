#!/usr/bin/env python3
"""Third-party licences of the panel binary (`make third-party`, release.yml).

The `akari` binary statically links Rust crates and embeds the built
frontends (spa/dist, the portal, and admin/dist, the admin app: the npm
packages bundled into them). This writes one text file:
a table of every such component with its declared licence, then the
licence/notice files those packages ship, verbatim (identical texts once).

Rust: `cargo metadata --locked` for the release targets (linux musl amd64 +
arm64), walking normal dependencies from akari-panel (build/dev deps and
proc-macro crates do not end up in the binary); licence files come from the
crate sources (`cargo fetch --locked` first). npm: spa/ and admin/
package-lock.json packages that are not dev-only (each name@version once);
licence files from node_modules when installed (`npm ci`), else only the
declared licence is listed.

The licence policy itself is enforced by `cargo deny check` (deny.toml) and
`npm audit`; this file is the notice that goes with the binary. Usage:
  python3 scripts/third-party.py [-o FILE]   (default target/THIRD_PARTY_LICENSES.txt)
"""
import argparse
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGETS = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"]
LIC_FILE = re.compile(r"^(licen[cs]e|copying|notice|unlicense)([.-][a-z0-9._-]*)?$", re.I)


def cargo_components():
    found = {}
    for target in TARGETS:
        meta = json.loads(
            subprocess.check_output(
                ["cargo", "metadata", "--locked", "--format-version", "1", "--filter-platform", target],
                cwd=ROOT,
            )
        )
        pkgs = {p["id"]: p for p in meta["packages"]}
        nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
        root = meta["resolve"]["root"]
        stack, seen = [root], {root}
        while stack:
            for dep in nodes[stack.pop()]["deps"]:
                if not any(k["kind"] is None for k in dep["dep_kinds"]):
                    continue  # build-/dev-only edge
                pid = dep["pkg"]
                p = pkgs[pid]
                if any("proc-macro" in t["kind"] for t in p["targets"]):
                    continue  # runs at compile time only
                if pid not in seen:
                    seen.add(pid)
                    stack.append(pid)
        for pid in seen - {root}:
            p = pkgs[pid]
            found[(p["name"], p["version"])] = p
    out = []
    for (name, version), p in sorted(found.items()):
        d = os.path.dirname(p["manifest_path"])
        files = []
        if p.get("license_file"):
            files.append(os.path.join(d, p["license_file"]))
        if os.path.isdir(d):
            files += [os.path.join(d, f) for f in sorted(os.listdir(d)) if LIC_FILE.match(f)]
        out.append(("crate", name, version, p.get("license") or "(see licence file)", dedupe(files)))
    return out


def npm_components():
    out, seen = [], set()
    for app in ("spa", "admin"):
        out += npm_app(app, seen)
    return out


def npm_app(app, seen):
    lock = json.load(open(os.path.join(ROOT, app, "package-lock.json")))
    out = []
    for path, p in sorted(lock.get("packages", {}).items()):
        if not path or p.get("dev") or p.get("devOptional"):
            continue
        name = path.split("node_modules/")[-1]
        if (name, p.get("version")) in seen:
            continue
        seen.add((name, p.get("version")))
        d = os.path.join(ROOT, app, path)
        files = []
        if os.path.isdir(d):
            files = [os.path.join(d, f) for f in sorted(os.listdir(d)) if LIC_FILE.match(f)]
        out.append(("npm", name, p.get("version", "?"), p.get("license") or "(not declared)", files))
    return out


def data_components():
    """Data files embedded in the binary under their own licence (W29: the
    built-in block lists, src/blockrules/lists/; W36-b: the portal's font
    subsets, Noto Sans SC under the SIL Open Font License)."""
    lists = os.path.join(ROOT, "src", "blockrules", "lists")
    version = open(os.path.join(lists, "VERSION")).read().strip()[:12]
    return [
        ("data", "v2fly/domain-list-community", version, "MIT", [os.path.join(lists, "LICENSE.v2fly")]),
        ("data", "Noto Sans SC (portal subset)", "variable", "OFL-1.1",
         [os.path.join(ROOT, "spa", "fonts-src", "noto", "OFL.txt")]),
    ]


def dedupe(files):
    seen, out = set(), []
    for f in files:
        r = os.path.realpath(f)
        if r not in seen and os.path.isfile(r):
            seen.add(r)
            out.append(f)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", default=os.path.join(ROOT, "target", "THIRD_PARTY_LICENSES.txt"))
    a = ap.parse_args()
    comps = cargo_components() + npm_components() + data_components()
    lines = [
        "akari (panel): third-party licences of the binary",
        "Generated by scripts/third-party.py (`make third-party`).",
        "",
        "akari-panel's own code is MIT licensed (LICENSE). The binary statically links the",
        "Rust crates below and embeds the web console built from the npm packages below",
        "and the data files below (built-in block lists);",
        "each is distributed under its own licence (declared licence first, texts follow).",
        "Licence policy: deny.toml (cargo deny check, CI).",
        "",
        "COMPONENTS (%d)" % len(comps),
        "",
    ]
    w = max(len("%s %s" % (c[1], c[2])) for c in comps)
    for kind, name, version, lic, _ in comps:
        lines.append("  %-5s %-*s  %s" % (kind, w, "%s %s" % (name, version), lic))
    lines += ["", "LICENCE AND NOTICE TEXTS"]
    texts = {}
    order = []
    for kind, name, version, _, files in comps:
        for f in files:
            body = open(f, "rb").read().decode("utf-8", "replace").rstrip()
            if body not in texts:
                texts[body] = []
                order.append(body)
            texts[body].append("%s %s %s: %s" % (kind, name, version, os.path.basename(f)))
    for body in order:
        lines += ["", "=" * 78] + texts[body] + ["-" * 78, "", body]
    os.makedirs(os.path.dirname(os.path.abspath(a.o)), exist_ok=True)
    with open(a.o, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    missing = sum(1 for c in comps if not c[4])
    print("%s: %d components, %d distinct texts, %d without a licence file" % (a.o, len(comps), len(order), missing))


if __name__ == "__main__":
    sys.exit(main())

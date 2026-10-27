#!/usr/bin/env python3
"""Keeps the installers' message tables and shared UI block honest.

The panel installer (scripts/install.sh) and the node installer the panel
serves (src/nodeinstall.sh, src/nodeinstall-ui.sh, src/nodeinstall-uninstall.sh)
print every user-facing string through a message table: a shell function
msg_zh / msg_en (node: also msg_zh_core / msg_en_core) holding
`key) m '...' ;;` entries, looked up by `msg KEY ARGS...` and printed with
printf. This check fails when

  * a key exists in one language and not the other (per script);
  * the two translations of a key take a different number of %s arguments, or
    use any other printf conversion;
  * a table line is not a well-formed entry;
  * a key is used by a call (step, note, ok, warn, die, say, msg, ask,
    confirm, menu, card_*) but defined nowhere, or defined but never used;
  * the shared UI block (# >>> akari-ui >>> ... # <<< akari-ui <<<) differs
    between the two scripts.

Run: scripts/installer-test/ui-check.py   (make shellcheck runs it)
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = {
    "install.sh": [ROOT / "scripts/install.sh"],
    "nodeinstall": [
        ROOT / "src/nodeinstall.sh",
        ROOT / "src/nodeinstall-ui.sh",
        ROOT / "src/nodeinstall-uninstall.sh",
    ],
}
TABLES = {"zh": ("msg_zh", "msg_zh_core"), "en": ("msg_en", "msg_en_core")}
ENTRY = re.compile(r"^\t([a-z][a-z0-9_]*)\) m '((?:[^']|'\\'')*)' ;;$", re.S)
FUNC_END = re.compile(r"^\}\n", re.M)
errors = []


def err(msg):
    errors.append(msg)


def table_spans(text, names):
    """(name, start, end) of each table function present in text."""
    out = []
    for name in names:
        m = re.search(r"^%s\(\) \{\n" % re.escape(name), text, re.M)
        if not m:
            continue
        e = FUNC_END.search(text, m.end())
        out.append((name, m.start(), e.end()))
    return out


def parse_table(text, start, end, label):
    body = text[start:end]
    lines = body.split("\n")
    # drop the header, `case`, the default arm, `esac` and the closing brace
    inner = "\n".join(lines[2:])
    inner = inner.rsplit("\t*) m \"$1\" ;;", 1)[0]
    entries = {}
    pos = 0
    # entries start at "\t<key>) m '" at the beginning of a line
    starts = [m.start() for m in re.finditer(r"^\t[a-z][a-z0-9_]*\) m '", inner, re.M)]
    if not starts:
        err("%s: no entries found" % label)
    for i, st in enumerate(starts):
        en = starts[i + 1] if i + 1 < len(starts) else len(inner)
        chunk = inner[st:en].rstrip("\n")
        m = ENTRY.match(chunk)
        if not m:
            err("%s: malformed table entry: %r" % (label, chunk[:80]))
            continue
        key, val = m.group(1), m.group(2).replace("'\\''", "'")
        if key in entries:
            err("%s: key %s defined twice" % (label, key))
        entries[key] = val
        pos = en
    return entries


def conversions(val):
    stripped = val.replace("%%", "")
    return re.findall(r"%.", stripped)


def check_script(name, files):
    texts = {f: f.read_text(encoding="utf-8") for f in files}
    tables = {"zh": {}, "en": {}}
    spans = {}
    for f, text in texts.items():
        for lang, names in TABLES.items():
            for tname, st, en in table_spans(text, names):
                spans.setdefault(f, []).append((st, en))
                for k, v in parse_table(text, st, en, "%s %s" % (f.name, tname)).items():
                    if k in tables[lang]:
                        err("%s: key %s defined in two tables (%s)" % (name, k, lang))
                    tables[lang][k] = v
    zh, en = tables["zh"], tables["en"]
    if not zh or not en:
        err("%s: message tables not found" % name)
        return
    for k in sorted(set(zh) - set(en)):
        err("%s: key %s has no English text" % (name, k))
    for k in sorted(set(en) - set(zh)):
        err("%s: key %s has no Chinese text" % (name, k))
    for k in sorted(set(zh) & set(en)):
        cz, ce = conversions(zh[k]), conversions(en[k])
        if cz != ce or any(c != "%s" for c in cz):
            err("%s: key %s: printf conversions differ or are not %%s: zh %s, en %s" % (name, k, cz, ce))
        for lang, v in (("zh", zh[k]), ("en", en[k])):
            if not v.strip():
                err("%s: key %s is empty in %s" % (name, k, lang))
            if "\x1b" in v:
                err("%s: key %s contains an escape character (%s)" % (name, k, lang))
    # call sites, outside the tables
    code = []
    for f, text in texts.items():
        cut = text
        for s0, e0 in sorted(spans.get(f, []), reverse=True):
            cut = cut[:s0] + cut[e0:]
        code.append(cut)
    code = "\n".join(code)
    used = set()
    word = r"([a-z][a-z0-9_]*)"
    sh = r"(?:\"[^\"]*\"|'[^']*'|[^\s\"']+)"
    for line in code.split("\n"):
        t = line.strip()
        if t.startswith("#"):
            continue
        for m in re.finditer(r"(?<![\w$.\-/])(?:step|note|ok|warn|die|say|msg|msg_has|card_open|card_text|card_row|confirm)\s+%s\b" % word, t):
            used.add(m.group(1))
        for m in re.finditer(r"(?<![\w$.\-/])ask(?:_secret)?\s+%s\s+%s\b" % (sh, word), t):
            used.add(m.group(1))
        for m in re.finditer(r"(?<![\w$.\-/])ask_valid\s+%s\s+%s\s+%s\s+%s\s+%s" % (sh, word, sh, sh, sh), t):
            used.add(m.group(1))
            ek = m.group(0).split()[-1]
            if re.fullmatch(r"[a-z][a-z0-9_]*", ek):
                used.add(ek)
        m = re.search(r"(?<![\w$.\-/])menu\s+%s\s+%s\s+%s\s+(.*)$" % (sh, word, sh), t)
        if m:
            used.add(m.group(1))
            for part in m.group(2).split():
                if "=" in part:
                    used.add(part.split("=", 1)[1])
        for m in re.finditer(r"ui_ask_error\s+\"\$\(msg\s+%s" % word, t):
            used.add(m.group(1))
    # keys used through variables (msg "$_ae" ...) or by name in the block
    for m in re.finditer(r"\bmsg\s+%s\b" % word, code):
        used.add(m.group(1))
    defined = set(zh) | set(en)
    for k in sorted(used - defined):
        err("%s: key %s is used but not defined" % (name, k))
    for k in sorted(defined - used):
        if k.endswith("_hint") and k[: -len("_hint")] in used:
            continue
        err("%s: key %s is defined but never used" % (name, k))
    print("%s: %d keys, zh/en complete" % (name, len(defined)))


def block(path):
    text = path.read_text(encoding="utf-8")
    m = re.search(r"^# >>> akari-ui >>>\n.*?^# <<< akari-ui <<<\n", text, re.S | re.M)
    if not m:
        err("%s: shared UI block markers not found" % path.name)
        return None
    return m.group(0)


for n, fs in SCRIPTS.items():
    check_script(n, fs)
a, b = block(ROOT / "scripts/install.sh"), block(ROOT / "src/nodeinstall-ui.sh")
if a is not None and b is not None and a != b:
    err("the shared UI block differs between scripts/install.sh and src/nodeinstall-ui.sh")
if errors:
    for e in errors:
        print("FAIL: " + e)
    sys.exit(1)
print("ui-check: ok")

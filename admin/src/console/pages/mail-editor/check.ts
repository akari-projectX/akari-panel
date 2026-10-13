// Client-side checks of a mail template draft (the same rules as the
// panel's `templates::validate` / `validate_html`, so problems show while
// typing, before the preview round trip): unknown and missing required
// placeholders with their line and column, empty parts. The server still
// validates everything (forbidden HTML, control characters, lengths).

export type MailField = "subject" | "body" | "html_source";

export type Problem = {
  /** Undefined: a server error without a place. */
  field: MailField | undefined;
  /** 1-based, when the problem has a place. */
  line?: number;
  column?: number;
  kind: "unknown" | "missing" | "empty" | "server";
  /** The placeholder name (unknown / missing). */
  name?: string;
  /** Unknown: the closest allowed name ("是不是 {order_no}？"). */
  suggest?: string;
  /** Server problems: the mapped error text. */
  text?: string;
};

export type Found = { name: string; from: number; to: number; line: number; column: number };

const NAME = /^[a-z0-9_]+$/;

/**
 * Every `{name}` in `s` with its offsets, scanned like the panel's
 * `placeholders_in`: from each `{` to the next `}`; a run that is not a
 * name is skipped from the character after the `{`.
 */
export function placeholdersIn(s: string): Found[] {
  const out: Found[] = [];
  let i = 0;
  while (true) {
    const open = s.indexOf("{", i);
    if (open < 0) break;
    const close = s.indexOf("}", open + 1);
    if (close < 0) break;
    const name = s.slice(open + 1, close);
    if (NAME.test(name)) {
      const before = s.slice(0, open);
      const nl = before.lastIndexOf("\n");
      out.push({
        name,
        from: open,
        to: close + 1,
        line: before.split("\n").length,
        column: open - nl,
      });
      i = close + 1;
    } else i = open + 1;
  }
  return out;
}

export type Draft = { subject: string; body: string; html: string; source: boolean };

/** Problems of a draft against the kind's allowed and required placeholders. */
export function checkDraft(d: Draft, allowed: string[], required: string[]): Problem[] {
  const out: Problem[] = [];
  const known = new Set(["site", ...allowed]);
  const fields: [MailField, string][] = [
    ["subject", d.subject],
    ["body", d.body],
  ];
  if (d.source) fields.push(["html_source", d.html]);
  for (const [field, text] of fields) {
    if (!text.trim()) {
      out.push({ field, kind: "empty" });
      continue;
    }
    const seen = new Set<string>();
    for (const p of placeholdersIn(text))
      if (!known.has(p.name) && !seen.has(p.name)) {
        seen.add(p.name);
        const near = closest(p.name, [...known]);
        out.push({
          field,
          kind: "unknown",
          name: p.name,
          line: p.line,
          column: p.column,
          ...(near ? { suggest: near } : {}),
        });
      }
  }
  const inText = new Set([...placeholdersIn(d.subject), ...placeholdersIn(d.body)].map((p) => p.name));
  for (const r of required) if (d.body.trim() && !inText.has(r)) out.push({ field: "body", kind: "missing", name: r });
  if (d.source && d.html.trim()) {
    const inHtml = new Set(placeholdersIn(d.html).map((p) => p.name));
    for (const r of required) if (!inHtml.has(r)) out.push({ field: "html_source", kind: "missing", name: r });
  }
  return out;
}

/** Edit distance (insert / delete / substitute / swap two neighbours = 1). */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/** The allowed name an unknown one most likely meant (close enough, or sharing a word), if any. */
export function closest(name: string, known: string[]): string | undefined {
  let best: { n: string; d: number } | undefined;
  for (const k of known) {
    const d = distance(name, k);
    if (!best || d < best.d) best = { n: k, d };
  }
  if (best && best.d <= Math.max(1, Math.floor(name.length / 3))) return best.n;
  const words = new Set(name.split("_").filter((w) => w.length > 2));
  return known.find((k) => k.split("_").some((w) => words.has(w)));
}

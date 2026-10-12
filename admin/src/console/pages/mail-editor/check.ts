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
        out.push({ field, kind: "unknown", name: p.name, line: p.line, column: p.column });
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

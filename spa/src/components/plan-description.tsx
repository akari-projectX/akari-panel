// W7: plan descriptions are "Markdown-lite" plain text written by the admin.
// Lines starting with "- ", "* " or "• " become a bullet list, other lines
// paragraphs (a blank line starts a new block). Everything is rendered as
// React text nodes: no HTML, no links, no inline styles — safe under the
// panel's strict CSP whatever the admin types.

export type DescriptionBlock = { kind: "p"; lines: string[] } | { kind: "ul"; items: string[] };

// "- item" (a lone "-" is an empty item, skipped); "-5%" is plain text.
const BULLET = /^\s*[-*•](?:\s+(.*))?$/;

/** Split description text into paragraphs and bullet lists. */
export function parseDescription(text: string): DescriptionBlock[] {
  const blocks: DescriptionBlock[] = [];
  let cur: DescriptionBlock | null = null;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      cur = null;
      continue;
    }
    const m = BULLET.exec(line);
    if (m) {
      const item = (m[1] ?? "").trim();
      if (item === "") continue;
      if (cur?.kind !== "ul") {
        cur = { kind: "ul", items: [] };
        blocks.push(cur);
      }
      cur.items.push(item);
    } else {
      if (cur?.kind !== "p") {
        cur = { kind: "p", lines: [] };
        blocks.push(cur);
      }
      cur.lines.push(line.trim());
    }
  }
  return blocks;
}

export function PlanDescription({ text }: { text: string }) {
  const blocks = parseDescription(text);
  if (blocks.length === 0) return null;
  return (
    <div className="space-y-1.5 text-sm text-muted-foreground">
      {blocks.map((b, i) =>
        b.kind === "ul" ? (
          <ul key={i} className="list-disc space-y-0.5 pl-5">
            {b.items.map((it, j) => (
              <li key={j}>{it}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            {b.lines.map((l, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {l}
              </span>
            ))}
          </p>
        ),
      )}
    </div>
  );
}

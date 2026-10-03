// HTML rendered by the panel from the safe Markdown subset (announcements,
// help articles). The server is the sanitizer (src/markdown.rs: no raw
// HTML, fixed tag/attribute set, links/images checked, fuzzed), so this
// only inserts it; never pass anything else here.
export function RichHtml({ html, className = "" }: { html: string; className?: string }) {
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

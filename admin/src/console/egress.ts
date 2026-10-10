// Relay egress checks (the entrance form).

/** The dial host (an IP literal) listed as an egress: the relay's entry
 *  address, which is almost never where its forwarded connections leave
 *  from (a field test filled in the entry IP and the relay never worked). */
export function entryAsEgress(host: string, cidrs: string): boolean {
  const h = host
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!/^[\d.]+$/.test(h) && !h.includes(":")) return false;
  return cidrs
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((c) => c.toLowerCase().replace(/\/(32|128)$/, "") === h);
}

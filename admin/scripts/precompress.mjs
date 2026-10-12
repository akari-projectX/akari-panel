// Pre-compressed copies of the built JS/CSS/SVG/JSON (`<file>.br`, `<file>.gz`)
// next to each original in dist/console and dist/login. The panel serves
// them by Accept-Encoding (src/console.rs `encoded`) — without a
// compressing proxy in front it otherwise sent every chunk raw. Fonts
// (woff2) and images are already compressed; HTML is rewritten per request.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["dist/console", "dist/login"];
const walk = (d) =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
let n = 0;
for (const root of roots)
  for (const f of walk(root)) {
    if (!/\.(js|css|svg|json)$/.test(f)) continue;
    const raw = readFileSync(f);
    if (raw.length < 1024) continue;
    writeFileSync(`${f}.br`, brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
    writeFileSync(`${f}.gz`, gzipSync(raw, { level: 9 }));
    n++;
  }
console.log(`precompress: ${n} files (.br + .gz)`);

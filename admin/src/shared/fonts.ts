// The web fonts (Inter + the Noto Sans SC subset, ~100 woff2 files by
// unicode-range) load AFTER the first screen: on a slow phone link their
// downloads competed with the entry chunk and the first data requests and
// held the first screen back by seconds. Until they arrive the system UI
// fonts of --font-sans show (PingFang / Noto CJK / YaHei), then swap.
import fontsCss from "../assets/fonts/fonts.css?url";

let started = false;

export function loadFonts(): void {
  if (started) return;
  started = true;
  const go = () => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = fontsCss;
    document.head.append(link);
  };
  if ("requestIdleCallback" in window) requestIdleCallback(go, { timeout: 1500 });
  else setTimeout(go, 100);
}

/** Load the fonts once the console's first page is ready (`main[data-ready]`), at the latest after `ms`. */
export function loadFontsAfterFirstScreen(ms = 4000): void {
  const done = () => {
    obs.disconnect();
    clearTimeout(timer);
    loadFonts();
  };
  const obs = new MutationObserver(() => {
    if (document.querySelector("main[data-ready]")) done();
  });
  obs.observe(document.documentElement, { subtree: true, childList: true, attributeFilter: ["data-ready"] });
  const timer = setTimeout(done, ms);
}

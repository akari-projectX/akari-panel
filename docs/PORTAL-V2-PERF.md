# Portal v2 performance (v2.0.0)

The v2.0.0 cutover replaced the React portal (`spa/`, removed) with the Svelte 5 portal (`portal/`).
This page records how the two compare on the same harness, so later changes have a reference point.

## Method

- Harness: `portal/e2e/perf/perf.spec.ts` (`portal/playwright.perf.config.ts`), run by `scripts/e2e-portal.sh` in the CI
  e2e job against a real panel (real CSP, seeded data, `user@e2e.test`); artifact `portal-perf`, summary in the job summary.
- Profiles: **desktop** = 1440×900, no throttling; **mobile-mid** = Pixel 7 viewport, 4× CPU slowdown, 150 ms RTT,
  1.6 Mbps down / 750 kbps up (Chrome DevTools Protocol).
- Each number is the **median of 5 runs**, in ms. Cold = fresh browser context, empty cache, session cookie only.
  FCP / LCP from PerformanceObserver; TTI = end of the last long task after FCP (simplified, ≥ DOMContentLoaded);
  content ready = boot screen gone, no `[aria-busy]` skeleton, page `h1` present.
- Route switch = client-side navigation (`pushState` + `popstate`) from the cold-loaded dashboard, in the order
  /nodes → /orders → /shop → /traffic → /, timed in the page until the new page's content is ready (new `h1` node,
  no skeleton). It starts once the dashboard has had 1 s without long tasks.
- Bundles: `portal/scripts/bundle-report.mjs dist/app` — gzip KiB; first-load = what `index.html` pulls in before the
  first page renders.

Runs:

| | CI run | commit |
|---|---|---|
| React (baseline, committed in `portal/e2e/perf/baseline/`) | 39818662219 (PR #148) | b3c92fe |
| React, earlier reference (PR 1 of portal v2, Svelte side was still placeholders) | 39696618479 | — |
| Svelte, final (PR #150 head) | 39859129537 | 4d833da |

## Results

| metric | desktop · react | desktop · svelte | Δ | mobile-mid · react | mobile-mid · svelte | Δ |
|---|---:|---:|---:|---:|---:|---:|
| login cold · FCP | 188 | 48 | −74% | 3744 | 1132 | −70% |
| login cold · LCP | 204 | 148 | −27% | 4100 | 3292 | −20% |
| login cold · TTI | 188 | 52 | −72% | 3748 | 1194 | −68% |
| login cold · content ready | 533 | 140 | −74% | 5820 | 3477 | −40% |
| dashboard cold · FCP | 236 | 56 | −76% | 4296 | 1124 | −74% |
| dashboard cold · LCP | 576 | 344 | −40% | 6636 | 4188 | −37% |
| dashboard cold · TTI | 236 | 56 | −76% | 8005 | 3974 | −50% |
| dashboard cold · content ready | 658 | 233 | −65% | 8234 | 5005 | −39% |
| route switch → /nodes | 127 | 5 | −96% | 224 | 190 | −15% |
| route switch → /orders | 116 | 8 | −93% | 162 | 122 | −25% |
| route switch → /shop | 141 | 13 | −91% | 367 | 87 | −76% |
| route switch → /traffic | 237 | 17 | −93% | 990 | 604 | −39% |
| route switch → / | 161 | 18 | −89% | 263 | 61 | −77% |

| bundle (KiB, gzip) | react | svelte | Δ |
|---|---:|---:|---:|
| first-load JS | 155.4 | 42.9 | −72% |
| first-load CSS | 24.3 | 9.6 | −60% |
| total JS | 436.9 | 232.0 | −47% |
| total CSS | 37.3 | 39.3 | +5% |

Every metric improves except total CSS (+2 KiB: per-page scoped CSS instead of one Tailwind sheet; first-load CSS is
60 % smaller). Single runs vary: in two earlier runs of the same code desktop login LCP came out 8–20 % above React.

## Route switches on phones

Before the fix the Svelte portal fetched a page's chunk only when the user navigated, then its data — two round trips
on a 150 ms link. On mobile-mid that was slower than React for the first visit to a page (React preloaded every page
chunk and some first-screen data on idle):

| mobile-mid, ms | React | no prefetch (run 39818662219, PR 5 state) | all at once (39838850056) | 2 at a time, shop before orders (39844896251 / 39853363791) | final: 3 at a time, orders before shop (39859129537) |
|---|---:|---:|---:|---:|---:|
| → /nodes | 224 | 272 | 495 | 42 / 43 | 190 |
| → /orders | 162 | 248 | 90 | 66 / 247 | 122 |
| → /shop | 367 | 491 | 415 | 33 / 33 | 87 |
| → /traffic | 990 | 545 | 239 | 476 / 522 | 604 |
| → / | 263 | 92 | 91 | 120 / 102 | 61 |

With shop before orders, /orders depended on whether its job had finished when the switch started (66 vs 247 ms in
two runs of the same code); the final order puts it second, and the third lane keeps /nodes, /orders and /shop ahead of
the harness. Every switch is now faster than React.

Fix (`portal/src/lib/prefetch.ts`, wired in `App.svelte` and `main.ts`):

- **Idle prefetch** once the boot screen is gone (signed in: `requestIdleCallback`, at most 500 ms): every page chunk the
  account scope may open, plus the first-screen data of nodes, shop, orders, tickets, announcements and docs (same cache
  keys as the pages' `resource`, only when not cached). Jobs run **three at a time in priority order** (nodes,
  orders, shop — the shop also needs the order list —, traffic, announcements, docs, tickets, wallet, settings; each
  page's chunk next to its data; chunks and first-screen JSON are small, so the cost is round trips, not bandwidth). Firing everything
  at once (the "all at once" column) made the first page compete with all the others for bandwidth and was slower than no
  prefetch. A preloaded page renders synchronously (`lib/lazy.ts` `preloadPage` / `loadedPage`); cached data paints at
  once and refreshes in the background.
- **Link intent**: pointer over / pointer down / keyboard focus on an in-site link preloads that page's chunk **and**
  starts its data request in parallel, so a click before the idle prefetch reaches that page costs one round trip, not two.
- Guest pages preload the other guest pages and the dashboard (where sign-in lands).
- Skipped with Save-Data or a connection slower than 4G, as in the React portal.

/traffic stays ahead of React; its data depends on the selected range, so only its chunk is prefetched.

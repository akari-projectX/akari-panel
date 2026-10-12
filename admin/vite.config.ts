/// <reference types="vitest/config" />
import { existsSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The admin app (W33-b): two independent builds, selected by ADMIN_ENTRY.
//   login    login.html -> dist/login,   assets at /app/assets/   (public: the sign-in page under the admin prefix)
//   console  index.html -> dist/console, assets at /admin/assets/ (admin sessions only)
// Separate builds so no shared chunk can carry console code into the public
// sign-in page. src/console.rs rewrites "/app/assets/" and "/admin/assets/"
// in the served HTML to the secret prefix (do not change `base`).
//
// The console splits into one chunk per page (react-router lazy routes,
// 2026-10 redesign). Every URL a JS or CSS file refers to (other chunks,
// fonts) is written relative to that file (`renderBuiltUrl`), so it
// resolves under the prefix the entry script was loaded from; only the HTML
// carries absolute "/admin/assets/" URLs, which the panel rewrites.
// scripts/check-bundles.mjs checks the output.
const entry = process.env.ADMIN_ENTRY === "login" ? "login" : "console";

/**
 * The panel version for the sidebar ("管理后台 · v0.4.4"): the console ships
 * inside the panel binary, so it is the root Cargo.toml's version (empty
 * when that file is not next to admin/, e.g. a bare admin checkout).
 */
function panelVersion(): string {
  const toml = new URL("../Cargo.toml", import.meta.url);
  if (!existsSync(toml)) return "";
  return /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(toml, "utf8"))?.[1] ?? "";
}

/** Console-only libraries: never in the public sign-in page (it stays small). */
const CONSOLE_LIBS =
  /\/node_modules\/(recharts|cmdk|react-router|@tanstack\/react-virtual|@tanstack\/react-query|@codemirror|d3-[a-z]+)\//;

/** The login build fails if a console module or library becomes reachable from it. */
function loginGuard(): Plugin {
  return {
    name: "akari-login-guard",
    apply: "build",
    moduleParsed(info) {
      const id = info.id.split("?")[0];
      if (/\/src\/console\//.test(id)) this.error(`console module reachable from the login page: ${id}`);
      if (CONSOLE_LIBS.test(id)) this.error(`console-only library reachable from the login page: ${id}`);
    },
  };
}

/**
 * Console chunking (perf: the first screen on a slow phone link): every
 * lucide icon in one chunk, and the small console/shared modules used by two
 * or more chunks in one "common" chunk, instead of ~70 tiny files of a few
 * hundred bytes each (each one a request and an import level). Modules over
 * 8 KB stay in the automatic split (a page only loads the big ones it uses).
 */
const CONSOLE_CHUNKS = {
  groups: [
    { name: "icons", test: /node_modules[\\/]lucide-react/ },
    { name: "common", test: /[\\/]src[\\/]/, minShareCount: 2, maxModuleSize: 8000 },
  ],
};

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(entry === "login" ? [loginGuard()] : [])],
  base: entry === "login" ? "/app/" : "/admin/",
  define: { __PANEL_VERSION__: JSON.stringify(panelVersion()) },
  build: {
    target: "es2022",
    outDir: `dist/${entry}`,
    emptyOutDir: true,
    // Module preload: the HTML lists the entry's static chunks and each lazy
    // page's import also fetches that page's chunks at once (one wave each
    // instead of a waterfall per import level; the deps are relative to the
    // importing file, like every other URL in JS).
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: entry === "login" ? "login.html" : "index.html",
      ...(entry === "console" ? { output: { codeSplitting: CONSOLE_CHUNKS } } : {}),
    },
  },
  experimental: {
    renderBuiltUrl: (_file, { hostType }) => (hostType === "js" || hostType === "css" ? { relative: true } : undefined),
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});

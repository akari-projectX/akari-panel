/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Two independent builds (R23), selected by AKARI_BUNDLE:
//   (unset) user portal  index.html -> dist/app,   assets at /assets/       (public, immutable)
//   admin   console      admin.html -> dist/admin, assets at /admin/assets/ (admin sessions only)
// Separate builds (not one multi-entry build) so no shared chunk can carry
// admin exports into the portal: each build tree-shakes its own graph.
// src/spa.rs rewrites the leading "/assets/" and "/admin/assets/" of the
// index to the secret prefix at serve time; do not change `base`.
const admin = process.env.AKARI_BUNDLE === "admin";

// Modules that only the console may load. The user build fails if any of
// them becomes reachable from src/main.tsx; scripts/check-bundles.mjs then
// greps the emitted files for admin markers as a second, independent check.
const ADMIN_ONLY = [
  /\/src\/admin-[^/]+$/,
  /\/src\/pages\/admin-[^/]+$/,
  /\/src\/pages\/audit\.tsx$/,
  /\/src\/lib\/admin-[^/]+$/,
];

function userBundleGuard(): Plugin {
  return {
    name: "akari-user-bundle-guard",
    apply: "build",
    moduleParsed(info) {
      const id = info.id.split("?")[0];
      if (ADMIN_ONLY.some((re) => re.test(id))) {
        this.error(`admin-only module reachable from the user portal entry: ${id}`);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(admin ? [] : [userBundleGuard()])],
  base: admin ? "/admin/" : "/",
  build: {
    target: "es2022",
    outDir: admin ? "dist/admin" : "dist/app",
    emptyOutDir: true,
    // W21: the console is code-split per view (React.lazy in admin-app.tsx;
    // it had passed 500 kB in one file). Chunks import each other with
    // relative specifiers, which resolve against the importing chunk's URL
    // and so keep the secret prefix. What must NOT appear is Vite's preload
    // helper: it builds absolute `base`-relative URLs ("/admin/assets/…")
    // that bypass the prefix rewrite of src/spa.rs. Hence no module
    // preloading and one CSS file (no per-chunk CSS for the helper to
    // load); scripts/check-bundles.mjs fails if the helper appears. The
    // portal stays one chunk (no dynamic import there).
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: { input: admin ? "admin.html" : "index.html" },
  },
  // Frontend unit tests (vitest + Testing Library, jsdom). Test files are
  // never imported by the app, so they are not in the bundle.
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});

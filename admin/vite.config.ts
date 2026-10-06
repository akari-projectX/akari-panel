/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The admin app (W33-b): two independent builds, selected by ADMIN_ENTRY.
//   login    login.html -> dist/login,   assets at /app/assets/   (public: the sign-in page under the admin prefix)
//   console  index.html -> dist/console, assets at /admin/assets/ (admin sessions only)
// Separate builds so no shared chunk can carry console code into the public
// sign-in page; src/console.rs rewrites "/app/assets/" and "/admin/assets/"
// to the secret prefix at serve time (do not change `base`). Each build is
// one chunk (no dynamic import): Vite's preload helper would use absolute
// base URLs that miss the prefix (scripts/check-bundles.mjs checks).
const entry = process.env.ADMIN_ENTRY === "login" ? "login" : "console";

/** The login build fails if a console module becomes reachable from it. */
function loginGuard(): Plugin {
  return {
    name: "akari-login-guard",
    apply: "build",
    moduleParsed(info) {
      const id = info.id.split("?")[0];
      if (/\/src\/console\//.test(id)) this.error(`console module reachable from the login page: ${id}`);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(entry === "login" ? [loginGuard()] : [])],
  base: entry === "login" ? "/app/" : "/admin/",
  build: {
    target: "es2022",
    outDir: `dist/${entry}`,
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: entry === "login" ? "login.html" : "index.html" },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});

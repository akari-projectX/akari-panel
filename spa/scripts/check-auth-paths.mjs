// Behavioural guard for REVIEW P0 #1: the SPA must call the auth endpoints at
// /{prefix}/auth/*, never under /{prefix}/api/v1. Loads the real api.ts
// (Node >= 22.18 strips TS types natively) with a fake location/fetch.
// Usage: node scripts/check-auth-paths.mjs
const calls = [];
globalThis.location = { pathname: "/pfx0123/app/users" };
globalThis.fetch = async (url, init) => {
  calls.push({ url, method: init?.method ?? "GET" });
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

const api = await import("../src/lib/api.ts");
await api.login({ login: "a", password: "b" });
await api.logout();
await api.get("/me");

const want = [
  { url: "/pfx0123/auth/login", method: "POST" },
  { url: "/pfx0123/auth/logout", method: "POST" },
  { url: "/pfx0123/api/v1/me", method: "GET" },
];
const got = JSON.stringify(calls);
if (got !== JSON.stringify(want)) {
  console.error(`FAIL: SPA request paths\n  want ${JSON.stringify(want)}\n  got  ${got}`);
  process.exit(1);
}
console.log("spa auth paths: ok");

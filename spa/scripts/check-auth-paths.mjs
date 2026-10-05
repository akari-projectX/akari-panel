// Behavioural guard for REVIEW P0 #1: the SPA must call the auth endpoints at
// /{prefix}/auth/*, never under /{prefix}/api/v1. Loads the real api.ts
// (Node >= 22.18 strips TS types natively) with a fake location/fetch.
// Also checks the logout cache transition (lib/session.ts) against the real
// @tanstack/query-core. Usage: node scripts/check-auth-paths.mjs
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
  console.error(
    `FAIL: Node ${process.versions.node} is too old: >= 22.18 is required to load TypeScript (type stripping).`,
  );
  process.exit(1);
}
const calls = [];
globalThis.location = { pathname: "/pfx0123/app/users" };
globalThis.fetch = async (url, init) => {
  calls.push({ url, method: init?.method ?? "GET" });
  // W27: /auth/options carries the form guard (fetched once, then reused).
  const body = String(url).endsWith("/auth/options")
    ? { guard: { form_token: "t", form_min_secs: 0, honeypot: true, turnstile: null } }
    : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

const api = await import("../src/lib/api.ts");
await api.login({ email: "a@b.cc", password: "b" });
await api.logout();
await api.get("/me");
// W15 public self-service endpoints are /auth/* too.
await api.authOptions();
await api.registerCode({ email: "a@b.cc" });
await api.register({ email: "a@b.cc", code: "123456", password: "password" });
await api.requestReset({ email: "a@b.cc" });
await api.resetPassword({ token: "t", password: "password" });

const want = [
  // W27: the first guarded form fetches /auth/options for its form token.
  { url: "/pfx0123/auth/options", method: "GET" },
  { url: "/pfx0123/auth/login", method: "POST" },
  { url: "/pfx0123/auth/logout", method: "POST" },
  { url: "/pfx0123/api/v1/me", method: "GET" },
  { url: "/pfx0123/auth/options", method: "GET" },
  { url: "/pfx0123/auth/register/code", method: "POST" },
  { url: "/pfx0123/auth/register", method: "POST" },
  { url: "/pfx0123/auth/password-reset/request", method: "POST" },
  { url: "/pfx0123/auth/password-reset", method: "POST" },
];
const got = JSON.stringify(calls);
if (got !== JSON.stringify(want)) {
  console.error(`FAIL: SPA request paths\n  want ${JSON.stringify(want)}\n  got  ${got}`);
  process.exit(1);
}
console.log("spa auth paths: ok");

// R23: the admin console (/{prefix}/admin/...) is a separate bundle on the
// same api.ts: it must derive the same prefix, API and auth bases, and the
// portal base it sends ended sessions to. (A query string = a fresh module
// instance that reads the new location.)
globalThis.location = { pathname: "/pfx0123/admin/nodes" };
const adminApi = await import("../src/lib/api.ts?admin");
calls.length = 0;
await adminApi.get("/me");
await adminApi.logout();
const adminWant = [
  { url: "/pfx0123/api/v1/me", method: "GET" },
  { url: "/pfx0123/auth/logout", method: "POST" },
];
const bases = [api.appBase, api.adminBase, adminApi.appBase, adminApi.adminBase];
const basesWant = ["/pfx0123/app", "/pfx0123/admin", "/pfx0123/app", "/pfx0123/admin"];
if (JSON.stringify(calls) !== JSON.stringify(adminWant) || JSON.stringify(bases) !== JSON.stringify(basesWant)) {
  console.error(
    `FAIL: console request paths/bases\n  want ${JSON.stringify(adminWant)} ${JSON.stringify(basesWant)}\n  got  ${JSON.stringify(calls)} ${JSON.stringify(bases)}`,
  );
  process.exit(1);
}
console.log("spa console paths: ok");

// Logout transition: an active "me" observer must end in the error state
// (-> <Login />) and no other cached query may survive.
const { QueryClient, QueryObserver } = await import("@tanstack/query-core");
const { resetAfterLogout } = await import("../src/lib/session.ts");
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let loggedIn = true;
const me = new QueryObserver(qc, {
  queryKey: ["me"],
  queryFn: async () => {
    if (!loggedIn) throw new Error("401");
    return { login: "root" };
  },
});
const seen = [];
const unsub = me.subscribe((r) => seen.push(r.status));
await qc.fetchQuery({ queryKey: ["users"], queryFn: async () => ["secret-user"] });
await new Promise((r) => setTimeout(r, 20));
if (me.getCurrentResult().status !== "success") {
  console.error("FAIL: logout test setup: me not loaded");
  process.exit(1);
}
loggedIn = false;
await resetAfterLogout(qc);
await new Promise((r) => setTimeout(r, 20));
unsub();
if (me.getCurrentResult().status !== "error" || !seen.includes("error")) {
  console.error(`FAIL: logout did not notify the "me" observer (statuses ${JSON.stringify(seen)})`);
  process.exit(1);
}
if (qc.getQueryData(["users"]) !== undefined) {
  console.error("FAIL: logout left other cached queries behind");
  process.exit(1);
}
console.log("spa logout transition: ok");

// Representative data for the design-compare screens, seeded once before
// any shot (zz-screens.spec.ts → seed()): two agent-like online servers
// (heartbeat in Valkey, 24 h of minute metrics, 7 d hourly, 30 d traffic
// incl. a relay entrance), three plans in a node group, 15 customers with
// spread sign-up dates, usage, expiry and last sign-in, ~40 orders over 60
// days (new / renew / switch; Alipay and manual; pending, expired,
// cancelled, refunded, one paid-but-unfulfilled), two coupons with
// redemptions, invite commissions (credited / frozen / reversed),
// withdrawals (pending / approved / rejected), a passkey on the shared
// user, system audit rows and, when an uploaded agent release exists, a
// running rollout.
//
// Only the real API and, where the API cannot create a state (time in the
// past, a gateway payment, an agent), SQL that keeps the schema's CHECKs
// and invariants (balances only through balance_ledger, orders' amount
// equation). Unique per run (a random tag). `stopSeed()` ends the
// heartbeat keep-alive (online = status 'online' and last_seen_at within
// 90 s, so it is refreshed every 20 s while the shots run).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DB, apiJson } from "../helpers";
import type { Ctx } from "./shared";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VALKEY_DB = process.env.E2E_VALKEY_DB ?? "15";
const GiB = 1024 ** 3;
const DAY = 86_400_000;

/** Run a command in the repository (docker compose), optionally with stdin; resolves stdout. */
function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: REPO });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`${args.slice(2, 4).join(" ")}: ${err.trim()}`)),
    );
    p.stdin.end(input ?? "");
  });
}

/** psql against the e2e database; several statements run as one transaction. */
const psql = (q: string) =>
  run("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "akari", "-d", DB, "-At", "-c", q]);

/** valkey-cli commands (one per line) against the e2e Valkey database. */
const valkey = (lines: string[]) =>
  run("docker", ["compose", "exec", "-T", "valkey", "valkey-cli", "-n", VALKEY_DB], lines.join("\n") + "\n");

/** A SQL string literal. */
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** `now()` minus `d` days (fractions allowed). */
const ago = (d: number) => `(now() - interval '${Math.round(d * 86400)} seconds')`;
/** The audit / snapshot label of a user (audit::user_label). */
const label = (id: string) => `u-${id.replace(/-/g, "").slice(0, 8)}`;

let keepAlive: ReturnType<typeof setInterval> | undefined;

/** Stop refreshing the seeded servers' heartbeats. */
export function stopSeed(): void {
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = undefined;
}

type Live = { id: string; domain: string; users: number; cpu: number; mem: number; rx: number; tx: number };

/** The heartbeat blob as grpc::heartbeat_value stores it. */
function blob(s: Live, n: number): string {
  const wobble = Math.sin(n / 3);
  return JSON.stringify({
    cpu_percent: +(s.cpu + 6 * wobble).toFixed(1),
    mem_used_bytes: Math.round(s.mem * 4 * GiB),
    mem_total_bytes: 4 * GiB,
    connections: Math.round(s.users * 19 + 40 * wobble),
    uptime_seconds: 41 * 86400 + n * 20,
    lease_remaining_seconds: 240,
    ts: new Date().toISOString(),
    metrics: {
      load1: +(s.cpu / 40 + 0.1 * wobble).toFixed(2),
      load5: +(s.cpu / 42).toFixed(2),
      load15: +(s.cpu / 45).toFixed(2),
      cpu_count: 2,
      swap_used_bytes: 120 * 1024 ** 2,
      swap_total_bytes: 2 * GiB,
      disk_used_bytes: 41 * GiB,
      disk_total_bytes: 80 * GiB,
      net_interface: "eth0",
      net_rx_bytes_per_sec: Math.round(s.rx * (1 + 0.15 * wobble)),
      net_tx_bytes_per_sec: Math.round(s.tx * (1 + 0.15 * wobble)),
      net_rx_bytes_total: 38 * 1024 * GiB,
      net_tx_bytes_total: 36 * 1024 * GiB,
      tcp_sockets: s.users * 21,
      udp_sockets: s.users * 3,
      online_users: s.users,
      process_rss_bytes: 210 * 1024 ** 2,
      xray_version: "25.9.11",
    },
    cert: {
      domain: s.domain,
      state: "valid",
      not_after: new Date(Date.now() + 71 * DAY).toISOString(),
      next_attempt: null,
      last_error: null,
      error_kind: null,
      last_error_at: null,
      challenge: null,
      failures: 0,
    },
    source_filter: { applied: true, error: null },
  });
}

async function beat(live: Live[], n: number): Promise<void> {
  const ids = live.map((s) => q(s.id)).join(",");
  await psql(`UPDATE servers SET status = 'online', last_seen_at = now() WHERE id IN (${ids})`);
  await valkey(
    live.flatMap((s) => [
      `SET akari:server:hb:${s.id} '${blob(s, n)}' EX 600`,
      `SET akari:server:online:${s.id} 1 EX 60`,
    ]),
  );
}

type Server = { id: string; nodes?: { id: string; entrances?: { id: string; kind: string }[] }[] };

/** Two enrolled, online servers with nodes, a relay entrance, metrics and 30 days of traffic. */
async function servers(c: Ctx, tag: string) {
  const mk = async (name: string, domain: string, node: string, region: string) => {
    const { id } = await apiJson<{ id: string }>("POST", "/servers", { name, tls_domain: domain }).catch(() =>
      apiJson<{ id: string }>("POST", "/servers", { name }),
    );
    const port = 20000 + Math.floor(Math.random() * 20000);
    const n = await apiJson<{ id: string }>("POST", "/nodes", {
      server_id: id,
      name: node,
      region,
      inbound: { protocol: "vmess", port, settings: { clients: [] } },
    });
    return { id, node: n.id, port };
  };
  const tyo = await mk(`东京 Linode 01 ${tag}`, `tyo-${tag}.example.com`, `东京 01 ${tag}`, "JP");
  const hkg = await mk(`香港 HKT 02 ${tag}`, `hkg-${tag}.example.com`, `香港 02 ${tag}`, "HK");
  await apiJson("POST", `/nodes/${tyo.node}/entrances`, {
    name: "IPLC 广港",
    connect_host: `iplc-gz-${tag}.example.com`,
    connect_port: 30002,
    listen_port: tyo.port + 1,
    source_cidrs: ["203.0.113.9/32"],
    rate: 1.5,
  });
  const all = await apiJson<Server[]>("GET", "/servers");
  const ents = (sid: string) => all.find((s) => s.id === sid)?.nodes?.flatMap((n) => n.entrances ?? []) ?? [];
  const tDirect = ents(tyo.id).find((e) => e.kind === "direct")?.id;
  const tRelay = ents(tyo.id).find((e) => e.kind === "relay")?.id;
  const hDirect = ents(hkg.id).find((e) => e.kind === "direct")?.id;
  const live: Live[] = [
    { id: tyo.id, domain: `tyo-${tag}.example.com`, users: 96, cpu: 34, mem: 0.62, rx: 31e6, tx: 29e6 },
    { id: hkg.id, domain: `hkg-${tag}.example.com`, users: 41, cpu: 21, mem: 0.48, rx: 14e6, tx: 12e6 },
  ];
  const ids = live.map((s) => q(s.id)).join(",");
  await psql(
    `UPDATE servers SET cert_serial = md5(id::text || 'screens'), cert_not_after = now() + interval '80 days', ` +
      `enrolled_at = now() - interval '41 days', created_at = now() - interval '42 days', status = 'online', ` +
      `last_seen_at = now(), online_session = NULL, agent_version = 'v0.8.2', core_version = '25.9.11', ` +
      `agent_protocol = 7, agent_os = 'linux', agent_arch = 'amd64', agent_capabilities = ARRAY['source-filter'], ` +
      `agent_addr = CASE WHEN id = ${q(tyo.id)} THEN '203.0.113.21'::inet ELSE '198.51.100.42'::inet END ` +
      `WHERE id IN (${ids});` +
      // Minute history for the last 24 h, hourly for 7 days (nodestat::history).
      metricsSql("server_metrics_1m", ids, 1440, "minute", 6) +
      metricsSql("server_metrics_1h", ids, 168, "hour", 360) +
      // 30 site days of traffic per entrance (dashboard, fleet, entrance traffic).
      `INSERT INTO traffic_entrance_daily (entrance_id, day, node_id, up_bytes, down_bytes, billed_bytes, users) ` +
      `SELECT e.id, akari_site_day(now()) - g, e.node_id, ` +
      `(x.gib * (0.75 + 0.35 * random()) * (CASE WHEN g = 0 THEN 0.55 ELSE 1 END) * 0.07 * ${GiB})::bigint, ` +
      `(x.gib * (0.75 + 0.35 * random()) * (CASE WHEN g = 0 THEN 0.55 ELSE 1 END) * 0.93 * ${GiB})::bigint, ` +
      `(x.gib * x.rate * (CASE WHEN g = 0 THEN 0.55 ELSE 1 END) * ${GiB})::bigint, x.users - (g % 5) ` +
      `FROM (VALUES ${[
        [tDirect, 210, 1, 88],
        [tRelay, 95, 1.5, 34],
        [hDirect, 130, 1, 41],
      ]
        .filter(([e]) => e)
        .map(([e, gib, rate, users]) => `(${q(e as string)}::uuid, ${gib}, ${rate}, ${users})`)
        .join(", ")}) x(id, gib, rate, users) ` +
      `JOIN entrances e ON e.id = x.id CROSS JOIN generate_series(0, 29) g ON CONFLICT DO NOTHING`,
  );
  await beat(live, 0);
  let n = 0;
  keepAlive = setInterval(() => {
    n++;
    beat(live, n).catch((e: Error) => console.log(`screens seed: heartbeat failed (${e.message.split("\n")[0]})`));
  }, 20_000);
  c.extra.liveServer = tyo.id;
  c.extra.liveServer2 = hkg.id;
  return { tyo, hkg, tDirect, tRelay, hDirect };
}

function metricsSql(table: string, ids: string, count: number, unit: "minute" | "hour", samples: number): string {
  const s = samples;
  const w = unit === "minute" ? 90 : 4; // one wave ≈ 9.4 h / 1 day
  return (
    `INSERT INTO ${table} (server_id, bucket, samples, cpu_sum, cpu_max, load1_sum, mem_used_sum, mem_total, ` +
    `swap_used_sum, swap_total, disk_used, disk_total, rx_bps_sum, tx_bps_sum, rx_bps_max, tx_bps_max, tcp_sum, ` +
    `udp_sum, conns_sum, conns_max, users_sum, users_max) ` +
    `SELECT s.id, date_trunc('${unit}', now()) - g * interval '1 ${unit}', ${s}, ` +
    `${s} * (28 + 12 * sin(g / ${w}.0) + 5 * random()), 45 + 15 * sin(g / ${w}.0) + 15 * random(), ` +
    `${s} * (0.7 + 0.3 * sin(g / ${w}.0)), ${s} * (2.5e9 + 2e8 * sin(g / ${w * 2}.0)), ${4 * GiB}, ` +
    `${s} * 1.2e8, ${2 * GiB}, ${41 * GiB}, ${80 * GiB}, ` +
    `${s} * (24e6 + 12e6 * sin(g / ${w}.0) + 3e6 * random()), ${s} * (22e6 + 11e6 * sin(g / ${w}.0) + 3e6 * random()), ` +
    `(48e6 + 8e6 * random())::bigint, (44e6 + 8e6 * random())::bigint, ${s} * (1500 + 500 * sin(g / ${w}.0)), ` +
    `${s} * 180, ${s} * (1400 + 500 * sin(g / ${w}.0)), 2300, ${s} * (70 + 25 * sin(g / ${w}.0)), 118 ` +
    `FROM unnest(ARRAY[${ids}]::uuid[]) s(id) CROSS JOIN generate_series(1, ${count}) g ON CONFLICT DO NOTHING;`
  );
}

type Period = "month" | "quarter" | "year";
const LEN: Record<Period, number> = { month: 30, quarter: 90, year: 365 };
/** One paid order: days ago, plan index, period, Alipay (default) or a manual record, coupon, refunded. */
type Buy = { d: number; plan: number; period: Period; manual?: boolean; coupon?: 0 | 1; refund?: boolean };
type Person = {
  local: string;
  age: number;
  buys: Buy[];
  usage?: number;
  login?: number;
  inviter?: "a" | "b";
};

// Fifteen customers: expiring soon, expired, renewing, switching, refunded,
// fresh sign-ups, two inviters (chen.jie, lin.feng).
const PEOPLE: Person[] = [
  {
    local: "zhang.wei",
    age: 58,
    buys: [
      { d: 57, plan: 0, period: "month" },
      { d: 27.5, plan: 0, period: "month" },
    ],
    usage: 0.91,
    login: 0.2,
  },
  { local: "li.na", age: 52, buys: [{ d: 50, plan: 1, period: "quarter", coupon: 0 }], usage: 0.45, login: 1.3 },
  {
    local: "wang.fang",
    age: 45,
    buys: [
      { d: 44, plan: 1, period: "month" },
      { d: 14, plan: 1, period: "month", manual: true },
    ],
    usage: 0.3,
    login: 3,
  },
  {
    local: "liu.yang",
    age: 40,
    buys: [
      { d: 39, plan: 0, period: "month" },
      { d: 9, plan: 1, period: "quarter", manual: true },
    ],
    usage: 0.12,
    login: 0.6,
  },
  { local: "chen.jie", age: 33, buys: [{ d: 32, plan: 2, period: "year" }], usage: 0.22, login: 0.1 },
  { local: "yang.min", age: 26, buys: [{ d: 25, plan: 1, period: "month" }], usage: 0.74, login: 2, inviter: "a" },
  {
    local: "zhao.lei",
    age: 21,
    buys: [{ d: 20, plan: 2, period: "year", coupon: 1 }],
    usage: 0.08,
    login: 5,
    inviter: "a",
  },
  {
    local: "huang.xin",
    age: 15,
    buys: [{ d: 14, plan: 1, period: "quarter", coupon: 1 }],
    usage: 0.18,
    login: 0.9,
    inviter: "a",
  },
  { local: "gao.yan", age: 12, buys: [{ d: 11, plan: 1, period: "month", refund: true }], usage: 0.02, inviter: "a" },
  {
    local: "zhou.ting",
    age: 4,
    buys: [{ d: 3, plan: 0, period: "month", coupon: 0 }],
    usage: 0.05,
    login: 1,
    inviter: "a",
  },
  { local: "wu.hao", age: 3, buys: [{ d: 2, plan: 1, period: "month" }], usage: 0.04, login: 0.3, inviter: "b" },
  { local: "xu.lan", age: 48, buys: [{ d: 47, plan: 0, period: "month" }], usage: 0.97, login: 18 },
  { local: "lin.feng", age: 37, buys: [{ d: 36, plan: 2, period: "year" }], usage: 0.35, login: 0.05 },
  { local: "he.yu", age: 2, buys: [{ d: 1, plan: 0, period: "month" }], usage: 0.01, login: 0.4 },
  { local: "ma.jun", age: 0.3, buys: [{ d: 0.1, plan: 0, period: "month", coupon: 0 }], usage: 0, login: 0.08 },
  { local: "sun.qi", age: 1, buys: [] },
];

/**
 * Seed everything (each part on its own: a failure is logged and the rest
 * still runs). Ids for the shots go to `c.extra`.
 */
export async function seed(c: Ctx): Promise<string[]> {
  const problems: string[] = [];
  const part = async (name: string, f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      problems.push(`seed ${name}: ${(e as Error).message.split("\n")[0]}`);
    }
  };
  const tag = Math.random().toString(36).slice(2, 7);
  const TAG = tag.toUpperCase();
  const me = await apiJson<{ id: string }>("GET", "/me");

  let fleet: Awaited<ReturnType<typeof servers>> | undefined;
  await part("servers", async () => {
    fleet = await servers(c, tag);
  });

  // ---- plans in a node group of the live entrances ------------------------
  const plans: { id: string; name: string }[] = [];
  await part("plans", async () => {
    const entrance_ids = [fleet?.tDirect, fleet?.tRelay, fleet?.hDirect].filter(Boolean);
    const g = await apiJson<{ id: string }>("POST", "/node-groups", {
      name: `标准线路 ${tag}`,
      description: "东京 / 香港直连 + 广港 IPLC",
      entrance_ids,
    });
    const defs: [string, number, [Period, number][]][] = [
      [
        `基础 ${tag}`,
        100,
        [
          ["month", 1900],
          ["quarter", 5400],
          ["year", 19900],
        ],
      ],
      [
        `专业 ${tag}`,
        300,
        [
          ["month", 3900],
          ["quarter", 10900],
          ["year", 39900],
        ],
      ],
      [`旗舰 ${tag}`, 1024, [["year", 69900]]],
    ];
    for (const [name, gib, prices] of defs) {
      const p = await apiJson<{ id: string }>("POST", "/plans", {
        name,
        period: "monthly",
        traffic_quota_bytes: gib * GiB,
        group_ids: [g.id],
        pricing: { on_sale: true, prices: prices.map(([period, price_cents]) => ({ period, price_cents })) },
      });
      plans.push({ id: p.id, name });
    }
  });
  if (plans.length < 3) return problems;

  // ---- coupons ---------------------------------------------------------------
  const coupons: { id: string; code: string; pct?: number; fixed?: number }[] = [];
  await part("coupons", async () => {
    const a = await apiJson<{ id: string }>("POST", "/coupons", {
      code: `NEW${TAG}`,
      name: "新人九折",
      kind: "percent",
      value: 10,
      new_users_only: true,
      max_uses: 1000,
    });
    coupons.push({ id: a.id, code: `NEW${TAG}`, pct: 10 });
    const b = await apiJson<{ id: string }>("POST", "/coupons", {
      code: `VIP${TAG}`,
      name: "老客户立减 20 元",
      kind: "fixed",
      value: 2000,
      min_amount_cents: 5000,
    });
    coupons.push({ id: b.id, code: `VIP${TAG}`, fixed: 2000 });
  });

  // ---- customers and their orders (real manual orders, then backdated) -------
  type Made = { p: Person; id: string; orders: { id: string; b: Buy }[] };
  const made: Made[] = [];
  // One person at a time: a refused order costs that person, not the rest.
  for (const p of PEOPLE)
    await part(`customer ${p.local}`, async () => {
      const u = await apiJson<{ id: string }>("POST", "/users", {
        email: `${p.local}.${tag}@example.com`,
        password: "screens-pass-1",
      });
      const m: Made = { p, id: u.id, orders: [] };
      made.push(m);
      for (const b of p.buys) {
        const o = await apiJson<{ id: string }>("POST", "/orders/manual", {
          user_id: u.id,
          plan_id: plans[b.plan]!.id,
          period: b.period,
          reason: b.manual ? "微信转账，已核对流水" : "screens",
        });
        m.orders.push({ id: o.id, b });
        if (!b.refund) continue;
        const { order } = await apiJson<{ order: { amount_cents: number } }>("GET", `/orders/${o.id}`);
        await apiJson("POST", `/orders/${o.id}/refund`, {
          reason: "用户申请退款：所在网络无法连接",
          external_cents: order.amount_cents,
        });
      }
    });
  const byLocal = (l: string) => made.find((m) => m.p.local === l);

  await part("orders", async () => {
    const method = `(SELECT id FROM payment_methods ORDER BY enabled DESC, sort, created_at LIMIT 1)`;
    const rows = made.flatMap((m) =>
      m.orders.map((o) => `(${q(o.id)}::uuid, ${o.b.d}::float8, ${o.b.manual ? "'manual'" : "'notify'"})`),
    );
    const disc = made.flatMap((m) =>
      m.orders
        .filter((o) => o.b.coupon !== undefined && coupons[o.b.coupon!])
        .map((o) => {
          const cp = coupons[o.b.coupon!]!;
          const d = cp.pct ? `(o.amount_cents * ${cp.pct} / 100)` : `LEAST(${cp.fixed}, o.amount_cents - 1)`;
          return `UPDATE orders o SET coupon_id = ${q(cp.id)}, coupon_code = ${q(cp.code)}, discount_cents = ${d}, amount_cents = o.amount_cents - ${d} WHERE o.id = ${q(o.id)} AND o.amount_cents > 1;`;
        }),
    );
    // Users: sign-up date, last sign-in, subscription dates, usage.
    const users = made.map((m) => {
      const first = m.p.buys[0];
      const term = m.p.buys.reduce((a, b) => a + LEN[b.period], 0);
      // A refund undid the subscription: the user has no plan (and no expiry to move).
      const exp = first && !m.p.buys.some((b) => b.refund) ? term - first.d : null;
      return `(${q(m.id)}::uuid, ${m.p.age}::float8, ${m.p.login ?? "NULL"}::float8, ${first ? first.d : "NULL"}::float8, ${exp ?? "NULL"}::float8, ${m.p.usage ?? 0}::float8)`;
    });
    const pending = [
      ["sun.qi", 0, "month", "new", "pending", 0.004, null],
      ["zhang.wei", 0, "quarter", "renew", "pending", 0.012, null],
      ["li.na", 1, "quarter", "renew", "pending", 0.02, null],
      ["xu.lan", 0, "month", "new", "expired", 6, null],
      ["sun.qi", 1, "month", "new", "expired", 0.9, null],
      ["wang.fang", 2, "year", "switch", "cancelled", 2.2, null],
      [
        "he.yu",
        2,
        "year",
        "switch",
        "paid",
        0.09,
        "the buyer's plan changed after the order was created; not replaced",
      ],
    ]
      .map(([l, plan, period, action, status, d, err]) => {
        const u = byLocal(l as string);
        if (!u) return null;
        return `(${q(u.id)}::uuid, ${q(plans[plan as number]!.id)}::uuid, ${q(period as string)}, ${q(action as string)}, ${q(status as string)}, ${ago(d as number)}, ${err ? q(err as string) : "NULL"}::text)`;
      })
      .filter(Boolean);
    await psql(
      (rows.length
        ? `UPDATE orders o SET created_at = v.at - interval '3 minutes', paid_at = v.at, ` +
          `expires_at = v.at + interval '27 minutes', ` +
          `fulfilled_at = CASE WHEN o.fulfilled_at IS NOT NULL THEN v.at + interval '2 seconds' END, ` +
          `refunded_at = CASE WHEN o.refunded_at IS NOT NULL THEN LEAST(v.at + interval '1 day', now()) END, ` +
          `paid_via = v.via, manual_reason = CASE WHEN v.via = 'manual' THEN o.manual_reason END, ` +
          `trade_no = CASE WHEN v.via = 'notify' THEN to_char(v.at, 'YYYYMMDD') || '2200' || substr(md5(o.id::text), 1, 16) ELSE o.trade_no END, ` +
          `payment_method_id = CASE WHEN v.via = 'notify' THEN ${method} ELSE o.payment_method_id END ` +
          `FROM (SELECT id, now() - d * interval '1 day' AS at, via FROM (VALUES ${rows.join(", ")}) x(id, d, via)) v ` +
          `WHERE o.id = v.id;`
        : "") +
        disc.join("") +
        (pending.length
          ? `INSERT INTO orders (id, out_trade_no, user_id, user_label, plan_id, plan_name, amount_cents, subject, ` +
            `status, created_at, expires_at, paid_at, paid_via, trade_no, ended_at, period, list_price_cents, action, ` +
            `payment_method_id, fulfil_error) ` +
            `SELECT gen_random_uuid(), 'AK' || to_char(v.at, 'YYYYMMDD') || substr(md5(random()::text || v.uid::text), 1, 24), ` +
            `u.id, 'u-' || left(replace(u.id::text, '-', ''), 8), p.id, p.name, pp.price_cents, 'Akari - ' || p.name, ` +
            `v.status, v.at, v.at + interval '30 minutes', ` +
            `CASE WHEN v.status = 'paid' THEN v.at + interval '40 seconds' END, ` +
            `CASE WHEN v.status = 'paid' THEN 'notify' END, ` +
            `CASE WHEN v.status = 'paid' THEN to_char(v.at, 'YYYYMMDD') || '2200' || substr(md5(random()::text), 1, 16) END, ` +
            `CASE WHEN v.status = 'expired' THEN v.at + interval '30 minutes' WHEN v.status = 'cancelled' THEN v.at + interval '4 minutes' END, ` +
            `v.period, pp.price_cents, v.action, ${method}, v.err ` +
            `FROM (VALUES ${pending.join(", ")}) v(uid, pid, period, action, status, at, err) ` +
            `JOIN users u ON u.id = v.uid JOIN plans p ON p.id = v.pid ` +
            `JOIN plan_period_prices pp ON pp.plan_id = p.id AND pp.period = v.period;`
          : "") +
        `UPDATE users u SET created_at = now() - v.age * interval '1 day', ` +
        `last_login_at = now() - v.login * interval '1 day', ` +
        `expires_at = CASE WHEN v.exp IS NULL THEN u.expires_at ELSE now() + v.exp * interval '1 day' END, ` +
        `traffic_used_bytes = CASE WHEN u.traffic_limit_bytes IS NULL THEN 0 ELSE (u.traffic_limit_bytes * v.usage)::bigint END ` +
        `FROM (VALUES ${users.join(", ")}) v(id, age, login, first, exp, usage) WHERE u.id = v.id;` +
        `UPDATE user_plans up SET starts_at = now() - v.first * interval '1 day', ` +
        `period_anchor = now() - v.first * interval '1 day', created_at = now() - v.first * interval '1 day', ` +
        `expires_at = now() + v.exp * interval '1 day' ` +
        `FROM (VALUES ${users.join(", ")}) v(id, age, login, first, exp, usage) ` +
        `WHERE up.user_id = v.id AND up.status = 'active' AND v.first IS NOT NULL;` +
        // The coupons' redemptions (what the coupon list counts).
        `INSERT INTO coupon_redemptions (order_id, coupon_id, user_id, status, discount_cents, created_at, updated_at) ` +
        `SELECT id, coupon_id, user_id, 'redeemed', discount_cents, paid_at, paid_at FROM orders ` +
        `WHERE coupon_id IN (${coupons.map((x) => q(x.id)).join(",") || "NULL"}) AND discount_cents > 0;` +
        `UPDATE coupons c SET used = c.used + (SELECT count(*) FROM coupon_redemptions r WHERE r.coupon_id = c.id) ` +
        `WHERE c.id IN (${coupons.map((x) => q(x.id)).join(",") || "NULL"});` +
        // System audit rows (gateway payments, expiries), dated like the orders.
        `INSERT INTO audit_log (at, actor_label, action, target_type, target_id, before, after) ` +
        `SELECT paid_at, 'system', 'order.paid', 'order', id::text, jsonb_build_object('status', 'pending'), ` +
        `jsonb_build_object('status', 'paid', 'paid_via', 'notify', 'trade_no', trade_no, 'total_cents', amount_cents) ` +
        `FROM orders WHERE paid_via = 'notify' AND user_id IN (${made.map((m) => q(m.id)).join(",")});` +
        `INSERT INTO audit_log (at, actor_label, action, target_type, target_id, before, after) ` +
        `SELECT ended_at, 'system', 'order.expire', 'order', id::text, jsonb_build_object('status', 'pending'), ` +
        `jsonb_build_object('status', 'expired') FROM orders WHERE status = 'expired' ` +
        `AND user_id IN (${made.map((m) => q(m.id)).join(",")});`,
    );
    c.extra.unfulfilledOrder =
      (await psql(
        `SELECT id FROM orders WHERE fulfil_error IS NOT NULL AND status = 'paid' AND fulfilled_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      )) || undefined;
    c.extra.pendingOrder =
      (await psql(
        `SELECT id FROM orders WHERE status = 'pending' AND user_id IN (${made.map((m) => q(m.id)).join(",")}) ORDER BY created_at DESC LIMIT 1`,
      )) || undefined;
  });

  // ---- invite commissions, balances, withdrawals ---------------------------
  await part("finance", async () => {
    const a = byLocal("chen.jie");
    const b = byLocal("lin.feng");
    if (!a || !b) return;
    const inv = (k: "a" | "b") => (k === "a" ? a : b);
    const set = made
      .filter((m) => m.p.inviter)
      .map((m) => `UPDATE users SET inviter_id = ${q(inv(m.p.inviter!).id)} WHERE id = ${q(m.id)};`);
    // One commission per invitee's first order: credited after the 7-day
    // hold, still frozen, or reversed (the refunded order).
    const com = made
      .filter((m) => m.p.inviter && m.orders[0])
      .map((m) => {
        const o = m.orders[0]!;
        const i = inv(m.p.inviter!);
        const status = o.b.refund ? "reversed" : o.b.d > 7 ? "credited" : "pending";
        return `(${q(o.id)}::uuid, ${q(i.id)}::uuid, ${q(m.id)}::uuid, ${q(status)}, ${o.b.d}::float8)`;
      });
    const admin = label(me.id);
    const W = (status: string, cents: number, d: number, chain: string, address: string, extra = "") =>
      `INSERT INTO withdrawals (id, user_id, user_label, amount_cents, status, chain, address, usdt_micros, txid, ` +
      `note, decided_at, decided_by, created_at) VALUES (gen_random_uuid(), ${q(a.id)}, ${q(label(a.id))}, ${cents}, ` +
      `${q(status)}, ${q(chain)}, ${q(address)}, ${extra || "NULL, NULL, NULL"}, ` +
      `${status === "pending" ? "NULL, NULL" : `${ago(d - 0.8)}, ${q(admin)}`}, ${ago(d)});` +
      `INSERT INTO balance_ledger (user_id, user_label, kind, amount_cents, withdrawal_id, actor_label, created_at) ` +
      `SELECT user_id, user_label, 'withdrawal', -amount_cents, id, user_label, created_at FROM withdrawals ` +
      `WHERE user_id = ${q(a.id)} AND created_at = ${ago(d)} AND amount_cents = ${cents};`;
    await psql(
      set.join("") +
        `INSERT INTO commissions (id, order_id, inviter_id, inviter_label, invitee_id, invitee_label, base_cents, ` +
        `rate_percent, amount_cents, available_at, created_at) ` +
        `SELECT gen_random_uuid(), o.id, v.inviter, 'u-' || left(replace(v.inviter::text, '-', ''), 8), v.invitee, ` +
        `'u-' || left(replace(v.invitee::text, '-', ''), 8), o.amount_cents, 10, o.amount_cents * 10 / 100, ` +
        `o.paid_at + interval '7 days', o.paid_at ` +
        `FROM (VALUES ${com.join(", ")}) v(order_id, inviter, invitee, status, d) JOIN orders o ON o.id = v.order_id ` +
        `WHERE o.amount_cents >= 10;` +
        `UPDATE commissions c SET status = 'reversed', reversed_at = o.refunded_at, reverse_reason = '订单已退款' ` +
        `FROM orders o WHERE o.id = c.order_id AND o.refunded_at IS NOT NULL AND c.status = 'pending' ` +
        `AND c.inviter_id IN (${q(a.id)}, ${q(b.id)});` +
        `WITH due AS (SELECT c.id FROM commissions c JOIN orders o ON o.id = c.order_id ` +
        `WHERE c.status = 'pending' AND c.available_at <= now() AND c.inviter_id IN (${q(a.id)}, ${q(b.id)}) ORDER BY c.available_at), ` +
        `l AS (INSERT INTO balance_ledger (user_id, user_label, kind, amount_cents, commission_id, actor_label, created_at) ` +
        `SELECT c.inviter_id, c.inviter_label, 'commission', c.amount_cents, c.id, 'system', c.available_at ` +
        `FROM commissions c JOIN due ON due.id = c.id RETURNING id, commission_id) ` +
        `UPDATE commissions c SET status = 'credited', credited_at = c.available_at, ledger_id = l.id ` +
        `FROM l WHERE c.id = l.commission_id;` +
        // Approved (paid in USDT), rejected (funds back), and one pending request.
        W(
          "approved",
          3000,
          9,
          "trc20",
          "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
          `416670000, '7f3e9c1a5b2d4e6f8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f', NULL`,
        ) +
        W(
          "rejected",
          1500,
          5,
          "polygon",
          "0x52908400098527886E0F7030069857D2E4169EE7",
          `NULL, NULL, '地址与提现记录中的链不一致，请核对后重新申请'`,
        ) +
        `INSERT INTO balance_ledger (user_id, user_label, kind, amount_cents, withdrawal_id, actor_label, created_at) ` +
        `SELECT user_id, user_label, 'withdrawal_reversal', amount_cents, id, ${q(admin)}, decided_at FROM withdrawals ` +
        `WHERE user_id = ${q(a.id)} AND status = 'rejected';` +
        W("pending", 4000, 0.3, "trc20", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"),
    );
    c.extra.inviter = a.id;
  });

  // ---- the shared user: a passkey, sign-in, traffic -------------------------
  await part("shared user", async () => {
    if (!c.userId) return;
    await psql(
      `INSERT INTO webauthn_credentials (user_id, rp_id, cred_id, passkey, name, created_at, last_used_at) ` +
        `VALUES (${q(c.userId)}, 'localhost', decode(md5(random()::text) || md5(random()::text), 'hex'), '{}'::jsonb, ` +
        `'iPhone 15 Pro', now() - interval '20 days', now() - interval '2 hours');` +
        `UPDATE users SET last_login_at = now() - interval '2 hours', created_at = now() - interval '34 days', ` +
        `traffic_used_bytes = CASE WHEN traffic_limit_bytes IS NULL THEN 0 ELSE traffic_limit_bytes * 38 / 100 END ` +
        `WHERE id = ${q(c.userId)}`,
    );
  });

  // ---- per-user traffic on the live entrances (user detail, top users) -----
  await part("user traffic", async () => {
    const ents = [fleet?.tDirect, fleet?.tRelay, fleet?.hDirect].filter(Boolean) as string[];
    const uids = [...made.filter((m) => m.orders.length).map((m) => m.id), c.userId].filter(Boolean) as string[];
    if (!ents.length || !uids.length) return;
    await psql(
      `INSERT INTO traffic_daily (user_id, day, node_id, entrance_id, up_bytes, down_bytes, billed_bytes) ` +
        `SELECT u.id, akari_site_day(now()) - g, e.node_id, e.id, ` +
        `((0.05 + random()) * 0.25 * ${GiB})::bigint, ((0.05 + random()) * 3.2 * ${GiB})::bigint, ` +
        `((0.05 + random()) * 3.4 * ${GiB})::bigint ` +
        `FROM users u CROSS JOIN generate_series(0, 13) g ` +
        `JOIN entrances e ON e.id = (ARRAY[${ents.map(q).join(",")}]::uuid[])[1 + (g % ${ents.length})] ` +
        `WHERE u.id IN (${uids.map(q).join(",")}) AND u.created_at <= now() - g * interval '1 day' ON CONFLICT DO NOTHING`,
    );
  });

  // ---- a running rollout (needs an uploaded release for linux/amd64) -------
  await part("rollout", async () => {
    if (!fleet) return;
    const rel = await apiJson<{ version: string; os: string; arch: string; complete: boolean }[]>(
      "GET",
      "/agent-releases",
    );
    const v = rel.find((r) => r.complete && r.os === "linux" && r.arch === "amd64")?.version;
    if (!v) throw new Error("no uploaded linux/amd64 release");
    const r = await apiJson<{ id: string }>("POST", "/rollouts", {
      version: v,
      server_ids: [fleet.tyo.id, fleet.hkg.id],
      waves: [50, 100],
      health_timeout_secs: 86400,
      max_failure_ratio: 0.5,
    });
    c.extra.rollout = r.id;
  });

  return problems;
}

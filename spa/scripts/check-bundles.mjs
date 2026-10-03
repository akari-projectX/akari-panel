// R23 guard: the user portal bundle (dist/app) must contain no admin code.
// Greps every emitted file of the user build for admin markers (admin API
// paths, console-only identifiers and headings) and fails on any hit. The
// same markers must appear in the admin build (dist/admin), so the check
// cannot pass vacuously when a marker goes stale.
// Runs after `vite build` (npm run build); smoke repeats it on the bundle the
// panel actually serves. The build itself also refuses admin modules in the
// user graph (vite.config.ts, userBundleGuard).
// Usage: node scripts/check-bundles.mjs [userDir] [adminDir]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const userDir = process.argv[2] ?? "dist/app";
const adminDir = process.argv[3] ?? "dist/admin";

// Each marker: [label, regex]. Path markers match a string literal that
// starts with the admin API path ("/me/orders" etc. of the portal start
// with "/me" and do not match).
const Q = "[`\"']";
const MARKERS = [
  ["admin API /users", new RegExp(`${Q}/users\\b`)],
  ["admin API /nodes", new RegExp(`${Q}/nodes\\b`)],
  ["admin API /node-groups", new RegExp(`${Q}/node-groups\\b`)],
  ["admin API /plans", new RegExp(`${Q}/plans\\b`)],
  ["admin API /plan-prices", new RegExp(`${Q}/plan-prices\\b`)],
  ["admin API /orders", new RegExp(`${Q}/orders\\b`)],
  ["admin API /audit", new RegExp(`${Q}/audit\\b`)],
  ["admin API /agent-releases", /\/agent-releases/],
  ["admin API /rollouts", new RegExp(`${Q}/rollouts\\b`)],
  ["admin API /agent-updates", /\/agent-updates/],
  ["admin API /inbound-templates", /\/inbound-templates/],
  ["admin API enroll-token", /enroll-token/],
  ["admin API /settings", new RegExp(`${Q}/settings\\b`)],
  ["admin API /coupons", new RegExp(`${Q}/coupons\\b`)],
  ["admin API /coupon-batches", /\/coupon-batches/],
  ["admin API /users/batch", /\/users\/batch/],
  ["admin API export.csv", /export\.csv/],
  ["admin API /orders/manual", /\/orders\/manual/],
  ["heading 批量生成优惠码", /批量生成优惠码/],
  ["admin API /withdrawals", new RegExp(`${Q}/withdrawals\\b`)],
  ["admin API /commissions", new RegExp(`${Q}/commissions\\b`)],
  ["admin API /commission-settings", /\/commission-settings/],
  ["admin API /balances", new RegExp(`${Q}/balances\\b`)],
  ["admin API /tickets", new RegExp(`${Q}/tickets\\b`)],
  ["admin API /alerts", new RegExp(`${Q}/alerts\\b`)],
  ["admin API /admin-badges", /\/admin-badges/],
  ["heading 工单管理", /工单管理/],
  ["heading 告警中心", /告警中心/],
  ["heading 提现审核", /提现审核/],
  ["heading 新建优惠券", /新建优惠券/],
  ["heading 用量最高的用户 (W22)", /用量最高的用户/],
  ["button 检查更新", /检查更新/],
  ["rollout", /rollout/i],
  ["console title 管理后台", /管理后台/],
  ["heading 审计日志", /审计日志/],
  ["heading 灰度更新", /灰度更新/],
  ["button 新建节点", /新建节点/],
  ["heading 系统设置", /系统设置/],
  ["button 立即测速", /立即测速/],
  ["heading 连接地址", /连接地址/],
  ["admin assets path", /\/admin\/assets\//],
  // W15
  ["admin API /mail/outbox", /\/mail\/outbox/],
  ["button 发送测试邮件", /发送测试邮件/],
  ["heading 失败邮件", /失败邮件/],
  // W20
  ["button 复制订阅链接", /复制订阅链接/],
  // W21
  ["admin API /dashboard", new RegExp(`${Q}/dashboard\\b`)],
  ["dashboard 营收（支付宝实收）", /营收（支付宝实收）/],
  ["admin API /settings/site", /\/settings\/site/],
  ["console error texts (ADMIN_CODES)", /plan\.speed_limit_range/],
];
const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

function scan(dir) {
  let all;
  try {
    all = files(dir);
  } catch (err) {
    console.error(`FAIL: ${dir} is missing (${err.code ?? err}); build both bundles first`);
    process.exit(1);
  }
  return all.map((p) => ({ path: p, text: readFileSync(p, "utf8") }));
}

const user = scan(userDir);
const admin = scan(adminDir);
let failed = false;

if (!user.some((f) => f.path.endsWith(".js"))) {
  console.error(`FAIL: no JavaScript in ${userDir}`);
  failed = true;
}
for (const [label, re] of MARKERS) {
  for (const f of user) {
    const m = re.exec(f.text);
    if (m) {
      const at = f.text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, " ");
      console.error(`FAIL: user bundle carries admin marker "${label}" in ${f.path}: …${at}…`);
      failed = true;
    }
  }
  if (!admin.some((f) => re.test(f.text))) {
    console.error(`FAIL: marker "${label}" not found in the admin bundle (${adminDir}): stale guard`);
    failed = true;
  }
}
// W21: the console is code-split; chunks must load each other through
// relative imports only. Vite wraps each dynamic import in its preload
// helper with the chunk's dependencies, which it would fetch by absolute
// "/admin/assets/…" URLs that miss the secret prefix; vite.config.ts
// (modulePreload false, one CSS file) keeps every dependency list empty.
for (const f of [...user, ...admin]) {
  if (!f.path.endsWith(".js")) continue;
  for (const m of f.text.matchAll(/\(\)=>import\(`([^`]+)`\),(\[[^\]]*\])/g)) {
    if (m[2] !== "[]") {
      console.error(`FAIL: ${f.path}: dynamic import ${m[1]} preloads ${m[2]} by absolute URL (misses the prefix)`);
      failed = true;
    }
  }
  if (/import\((["'`])\/(?!\/)/.test(f.text)) {
    console.error(`FAIL: ${f.path}: absolute dynamic import (misses the prefix)`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`bundles: ok (${user.length} user files free of ${MARKERS.length} admin markers)`);

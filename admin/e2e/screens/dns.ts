// DNS (INVENTORY §10a). New page, so no v2 design shots to match: the names are
// ours (dns-*). Needs the Cloudflare mock of scripts/e2e.sh (E2E_CF_TOKEN).
import { expect } from "@playwright/test";

import { apiJson, must, uniq } from "../helpers";
import { go, goDialog, goto, need, type Ctx, type Shot } from "./shared";

const ZONE = "a".repeat(32);

export async function setup(c: Ctx): Promise<void> {
  const a = await apiJson<{ id: string }>("POST", "/dns/accounts", {
    name: uniq(c.info, "screens-dns"),
    token: must("E2E_CF_TOKEN"),
  });
  c.extra.dnsAccount = a.id;
}

const zone = (c: Ctx) => `/dns?zone=${need(c.extra.dnsAccount, "dns account")}:${ZONE}`;

export const shots: Shot[] = [
  { name: "dns-records", open: async (page, c) => goto(page, zone(c)), full: true },
  { name: "dns-records-search", open: async (page, c) => goto(page, `${zone(c)}&q=origin`) },
  {
    name: "dns-records-selected",
    open: async (page, c) => {
      await goto(page, `${zone(c)}&q=p0`);
      await page.getByRole("checkbox", { name: "全选本页" }).first().check();
      await expect(page.getByTestId("bulk-bar")).toBeVisible();
    },
  },
  { name: "dns-record-new", open: goDialog((c) => `${zone(c)}&new=1`) },
  { name: "dns-tokens", open: go("/dns?tokens=1") },
  {
    name: "dns-readonly",
    open: async (page, c) => goto(page, `/dns?zone=${need(c.extra.dnsAccount, "dns account")}:${"b".repeat(32)}`),
  },
];

// Servers, nodes, entrances (v2 shots/nodes.json).
import { expect } from "@playwright/test";

import { go, goDialog, goto, need, type Shot } from "./shared";

export const shots: Shot[] = [
  { name: "nodes-fleet-default", open: go("/nodes") },
  {
    name: "nodes-entrance-connect",
    open: goDialog((c) => `/nodes?open=entrance:${need(c.entranceId, "relay entrance")}`),
  },
  {
    name: "nodes-entrance-delete",
    open: async (page, c) => {
      await goto(page, `/nodes?open=entrance:${need(c.entranceId, "relay entrance")}`);
      await page.getByRole("dialog").getByRole("button", { name: /删除/ }).last().click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
];

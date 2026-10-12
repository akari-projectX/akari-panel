// Users and finance (v2 shots/people.json).
import { expect } from "@playwright/test";

import { goDialog, goto, need, type Shot } from "./shared";

export const shots: Shot[] = [
  { name: "users-list-default", open: async (page) => goto(page, "/users") },
  { name: "users-detail-overview", open: goDialog((c) => `/users?open=${need(c.userId, "user")}`) },
  {
    name: "users-bulk-delete",
    open: async (page) => {
      await goto(page, "/users");
      const boxes = page.locator("[data-row]:visible").getByRole("checkbox");
      await boxes.nth(0).click();
      await boxes.nth(1).click();
      await page.getByRole("button", { name: /删除/ }).last().click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
];

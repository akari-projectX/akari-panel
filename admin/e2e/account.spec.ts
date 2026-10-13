// INVENTORY §16 (my account; passkeys in zz-passkeys.spec.ts).
import { expect, test } from "@playwright/test";

import { CONSOLE, LOGIN, apiJson, signIn, toast, uniq } from "./helpers";

test("ACC-01 ACC-02 ACC-04: account details, password change, sign out", async ({ page }, info) => {
  const email = `${uniq(info, "acc")}@e2e.test`;
  await apiJson("POST", "/users", { email, password: "account-pass-1", role: "admin" });
  await signIn(page, email, "account-pass-1", "/account");
  // ACC-01.
  await expect(page.getByRole("heading", { level: 1, name: "我的账户" })).toBeVisible();
  await expect(page.getByRole("main").getByText(email).first()).toBeVisible();
  await expect(page.getByRole("main").getByText("管理员", { exact: true }).first()).toBeVisible();
  // ACC-02: the new password twice (a mismatch is caught here, with "N to fix"); a wrong current
  // password is shown at its field; the right one changes it.
  await page.getByLabel("当前密码").fill("wrong-pass-1");
  await page.getByLabel(/^新密码/).fill("account-pass-2");
  await page.getByLabel("再输一次新密码").fill("account-pass-3");
  await page.getByRole("button", { name: "修改密码" }).click();
  await expect(page.getByText("两次输入的新密码不一致")).toBeVisible();
  await expect(page.getByText("1 处需要修正")).toBeVisible();
  await page.getByLabel("再输一次新密码").fill("account-pass-2");
  await page.getByRole("button", { name: "修改密码" }).click();
  await expect(page.getByText("当前密码不正确")).toBeVisible();
  await page.getByLabel("当前密码").fill("account-pass-1");
  await page.getByRole("button", { name: "修改密码" }).click();
  await toast(page, "密码已修改");
  // This session stays.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "我的账户" })).toBeVisible();
  // ACC-04: sign out; the console is gone; the new password works.
  await page.getByRole("main").getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(`${LOGIN}?signed_out=1`);
  await expect(page.getByText("已退出登录。")).toBeVisible();
  expect((await page.request.get(CONSOLE)).status()).toBe(404);
  await signIn(page, email, "account-pass-2");
});

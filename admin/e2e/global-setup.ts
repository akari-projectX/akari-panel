// One enabled payment method for the shop, coupons and balance specs (throwaway
// keys, a gateway nobody listens on: the e2e purchases are fully covered by a
// coupon or the balance and never reach the gateway). Created through the
// admin API once per run (a second run against the same panel keeps it).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PAY_DIR, apiJson } from "./helpers";

type Payments = { methods: { id: string }[] };

export default async function globalSetup(): Promise<void> {
  const { methods } = await apiJson<Payments>("GET", "/settings/payments");
  if (methods.length > 0) return;
  const pem = (f: string) => readFileSync(join(PAY_DIR, f), "utf8");
  await apiJson("POST", "/settings/payments", {
    kind: "alipay_f2f",
    display_name: "支付宝",
    enabled: true,
    config: {
      environment: "custom",
      gateway_url: "http://127.0.0.1:9/gateway.do",
      app_id: "2021000000000000",
      seller_id: "2088000000000000",
      app_private_key: pem("app-key.pem"),
      alipay_public_key: pem("alipay-pub.pem"),
      order_timeout_minutes: 15,
    },
  });
}

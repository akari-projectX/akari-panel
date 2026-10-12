// Orders, coupons, plans, node groups (v2 shots/commerce.json).
import { go, type Shot } from "./shared";

export const shots: Shot[] = [
  { name: "orders-ledger-default", open: go("/orders") },
  { name: "orders-ledger-nomatch", open: go("/orders?q=no-such-order-zzzz") },
];

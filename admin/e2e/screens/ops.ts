// Dashboard, system status, alerts, updates, audit (v2 shots/ops.json).
// Not taken (states the real app cannot show on demand): dashboard-allclear
// (the e2e data always has pending work), *-loading, *-error, *-stale.
import { go, type Shot } from "./shared";

export const shots: Shot[] = [
  { name: "dashboard-default", open: go(""), full: true },
  { name: "dashboard-orders-30d", open: go("/?metric=orders&range=30d") },
  { name: "dashboard-traffic-today", open: go("/?metric=traffic&range=today") },
];

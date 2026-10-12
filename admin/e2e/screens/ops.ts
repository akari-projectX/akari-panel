// Dashboard, system status, alerts, updates, audit (v2 shots/ops.json).
import { go, type Shot } from "./shared";

export const shots: Shot[] = [{ name: "dashboard-default", open: go(""), full: true }];

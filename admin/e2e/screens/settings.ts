// System settings, mail templates (v2 shots/settings.json).
import { go, type Shot } from "./shared";

export const shots: Shot[] = [
  { name: "settings-overview", open: go("/settings") },
  { name: "settings-domains", open: go("/settings/domains") },
  { name: "settings-signup", open: go("/settings/signup") },
  { name: "settings-payments", open: go("/settings/payments") },
  { name: "settings-templates", open: go("/settings/mail-templates") },
];

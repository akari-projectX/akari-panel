// User portal entry (/{prefix}/app). Must never import admin modules (R23):
// the user build fails if any becomes reachable (vite.config.ts) and
// scripts/check-bundles.mjs greps the emitted files for admin markers.
import { App } from "./app";
import { mount } from "./mount";

mount(<App />);

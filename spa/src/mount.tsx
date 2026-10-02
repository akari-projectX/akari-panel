import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";

// Shared bootstrap of both bundles (user portal: main.tsx, admin console:
// admin-main.tsx). Each entry imports only its own shell.
export function mount(app: ReactElement): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>{app}</QueryClientProvider>,
  );
}

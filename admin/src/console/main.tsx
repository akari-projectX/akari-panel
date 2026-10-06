import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shared/index.css";
import { LangProvider } from "../shared/i18n";
import { applyTheme, initialTheme } from "../shared/theme";
import { Providers } from "../shared/ui/overlays";
import { ConsoleApp } from "./app";

applyTheme(initialTheme());

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 5_000 },
  },
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <LangProvider>
          <Providers>
            <ConsoleApp />
          </Providers>
        </LangProvider>
      </QueryClientProvider>
    </StrictMode>,
  );

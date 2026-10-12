import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import "../shared/index.css";
import { LangProvider } from "../shared/i18n";
import { applyTheme, initialTheme } from "../shared/theme";
import { ConfirmProvider } from "../shared/ui/confirm";
import { Toaster } from "../shared/ui/toast";
import { invalidateOnWrite, makeQueryClient } from "./data";
import { makeRouter } from "./routes";

applyTheme(initialTheme());

const client = makeQueryClient();
invalidateOnWrite(client);
const router = makeRouter();

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <LangProvider>
          <ConfirmProvider>
            <RouterProvider router={router} />
            <Toaster />
          </ConfirmProvider>
        </LangProvider>
      </QueryClientProvider>
    </StrictMode>,
  );

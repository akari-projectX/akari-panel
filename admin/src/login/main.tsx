import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shared/index.css";
import { LangProvider } from "../shared/i18n";
import { applyTheme, initialTheme } from "../shared/theme";
import { LoginApp } from "./app";

applyTheme(initialTheme());

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <LangProvider>
        <LoginApp />
      </LangProvider>
    </StrictMode>,
  );

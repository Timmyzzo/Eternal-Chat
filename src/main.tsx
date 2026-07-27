import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";

import { App } from "@/app/App";
import { ThemeProvider } from "@/app/ThemeProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { initializePersistence } from "@/infrastructure/db/startup";
import "@/styles/index.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element was not found");
}

const applicationRoot = createRoot(root);

function renderApplication() {
  applicationRoot.render(
    <StrictMode>
      <ThemeProvider>
        <TooltipProvider delayDuration={350}>
          <App />
        </TooltipProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}

if (isTauri()) {
  void initializePersistence().then(renderApplication);
} else {
  renderApplication();
}

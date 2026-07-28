import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";

import { App } from "@/app/App";
import { ThemeProvider } from "@/app/ThemeProvider";
import {
  createApplicationRuntime,
  createBrowserFixtureRuntime,
  type ApplicationRuntime,
} from "@/application/chat/runtime";
import { TooltipProvider } from "@/components/ui/tooltip";
import { initializePersistence } from "@/infrastructure/db/startup";
import { TauriDesktopBridge } from "@/infrastructure/desktop/tauriDesktopBridge";
import "@/styles/index.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element was not found");
}

const applicationRoot = createRoot(root);

function renderApplication(runtime: ApplicationRuntime) {
  applicationRoot.render(
    <StrictMode>
      <ThemeProvider>
        <TooltipProvider delayDuration={350}>
          <App runtime={runtime} />
        </TooltipProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}

async function createRuntime(): Promise<ApplicationRuntime> {
  if (!isTauri()) {
    return createBrowserFixtureRuntime();
  }
  const repository = await initializePersistence();
  const bridge = new TauriDesktopBridge({
    notifications: { async show() {} },
    async openExternal(url) {
      window.open(url, "_blank", "noopener,noreferrer");
    },
  });
  return createApplicationRuntime(repository, bridge);
}

void createRuntime()
  .then(renderApplication)
  .catch(() => {
    applicationRoot.render(
      <main className="startup-error" role="alert">
        Eternal Chat could not initialize its local workspace.
      </main>,
    );
  });

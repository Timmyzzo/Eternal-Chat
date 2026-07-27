import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/app/App";
import { ThemeProvider } from "@/app/ThemeProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/styles/index.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element was not found");
}

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider delayDuration={350}>
        <App />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);

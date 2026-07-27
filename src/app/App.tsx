import {
  Laptop,
  MessageCircleMore,
  MessagesSquare,
  Moon,
  Send,
  Settings2,
  Sun,
} from "lucide-react";
import { useReducedMotion } from "motion/react";

import { useTheme, type ThemeMode } from "@/app/ThemeProvider";
import { FluidSheet } from "@/components/shared/FluidSheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const themeOptions: ReadonlyArray<{
  value: ThemeMode;
  label: string;
  icon: typeof Laptop;
}> = [
  { value: "system", label: "System", icon: Laptop },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

function AppearanceSettings() {
  const { mode, setMode } = useTheme();
  const prefersReducedMotion = useReducedMotion();

  return (
    <div className="space-y-8" data-ui="settings.content">
      <section aria-labelledby="theme-label" className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold" id="theme-label">
            Theme
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Match this device or choose a fixed mode.
          </p>
        </div>

        <div
          aria-labelledby="theme-label"
          className="grid grid-cols-3 gap-1 rounded-md border border-border bg-panel p-1"
          role="radiogroup"
        >
          {themeOptions.map(({ value, label, icon: Icon }) => {
            const selected = mode === value;

            return (
              <button
                aria-checked={selected}
                className={cn(
                  "flex h-10 min-w-0 items-center justify-center gap-2 rounded-sm px-2 text-sm font-medium",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                  selected
                    ? "bg-surface text-foreground shadow-xs"
                    : "text-muted-foreground hover:bg-surface/60 hover:text-foreground",
                )}
                key={value}
                onClick={() => setMode(value)}
                role="radio"
                type="button"
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section
        aria-labelledby="motion-label"
        className="flex items-center justify-between gap-4 border-t border-border pt-5"
      >
        <div className="min-w-0">
          <h2 className="text-sm font-semibold" id="motion-label">
            Motion
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Uses the operating system preference.
          </p>
        </div>
        <output className="shrink-0 text-sm font-medium text-foreground">
          {prefersReducedMotion ? "Reduced" : "Standard"}
        </output>
      </section>
    </div>
  );
}

export function App() {
  return (
    <div
      className="grid h-dvh min-h-[35rem] min-w-[47.5rem] grid-cols-[clamp(13rem,22vw,15.5rem)_minmax(0,1fr)] bg-background text-foreground"
      data-ui="app.window"
    >
      <aside
        className="flex min-w-0 flex-col border-r border-border bg-panel"
        data-ui="app.sidebar"
      >
        <header className="flex h-14 items-center gap-3 border-b border-border px-4">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground">
            <MessageCircleMore aria-hidden="true" className="size-4" />
          </span>
          <span className="min-w-0 truncate text-sm font-semibold">Eternal Chat</span>
        </header>

        <nav aria-label="Primary" className="flex items-center gap-1 px-3 py-3">
          <div
            aria-current="page"
            className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md bg-selected px-3 text-sm font-medium"
          >
            <MessagesSquare aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">Conversations</span>
          </div>

          <FluidSheet
            description="Choose the application theme and review the current motion preference."
            title="Appearance"
            trigger={
              <Button aria-label="Open appearance settings" size="icon" variant="ghost">
                <Settings2 aria-hidden="true" className="size-4" />
              </Button>
            }
            triggerTooltip="Appearance"
          >
            <AppearanceSettings />
          </FluidSheet>
        </nav>

        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
          <div className="grid min-h-36 flex-1 place-items-center border-t border-border px-4 text-center">
            <div className="max-w-44">
              <MessagesSquare aria-hidden="true" className="mx-auto size-5 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium">No conversations</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Conversation history will appear here.
              </p>
            </div>
          </div>
        </div>
      </aside>

      <main
        className="grid min-w-0 grid-rows-[3.5rem_minmax(0,1fr)_auto] bg-surface"
        data-ui="app.content chat.view"
      >
        <header className="flex min-w-0 items-center justify-between border-b border-border bg-surface/88 px-5 backdrop-blur-xl">
          <h1 className="truncate text-sm font-semibold">Conversations</h1>
          <span className="text-xs text-muted-foreground">Local workspace</span>
        </header>

        <section
          className="grid min-h-0 place-items-center overflow-auto px-6 py-10"
          data-ui="chat.message-list"
        >
          <div className="max-w-sm text-center">
            <span className="mx-auto grid size-11 place-items-center rounded-md border border-border bg-panel text-muted-foreground">
              <MessageCircleMore aria-hidden="true" className="size-5" />
            </span>
            <h2 className="mt-4 text-base font-semibold">No conversation selected</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Your messages will appear in this workspace.
            </p>
          </div>
        </section>

        <footer className="border-t border-border bg-surface px-4 py-4">
          <div className="mx-auto flex w-full max-w-3xl items-end gap-2" data-ui="chat.composer">
            <textarea
              aria-label="Message"
              className="min-h-11 flex-1 resize-none rounded-md border border-border bg-panel px-3 py-3 text-sm text-muted-foreground outline-none disabled:cursor-not-allowed disabled:opacity-80"
              data-slot="composer-input"
              data-ui="part:composer-input"
              disabled
              placeholder="Select a conversation"
              rows={1}
            />
            <div data-slot="composer-actions" data-ui="part:composer-actions">
              <Button aria-label="Send message" disabled size="icon">
                <Send aria-hidden="true" className="size-4" />
              </Button>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}

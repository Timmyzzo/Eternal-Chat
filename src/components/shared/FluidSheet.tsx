import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  AnimatePresence,
  motion,
  useDragControls,
  useReducedMotion,
  type PanInfo,
} from "motion/react";
import { useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { shouldDismissRightSheet } from "@/components/shared/fluidSheetMotion";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface FluidSheetProps {
  children: ReactNode;
  closeLabel?: string;
  contentClassName?: string;
  description: string;
  title: string;
  trigger: ReactNode;
  triggerTooltip: string;
}

export function FluidSheet({
  children,
  closeLabel = "Close sheet",
  contentClassName,
  description,
  title,
  trigger,
  triggerTooltip,
}: FluidSheetProps) {
  const [open, setOpen] = useState(false);
  const dragControls = useDragControls();
  const prefersReducedMotion = useReducedMotion();

  const handleDragStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (!prefersReducedMotion) {
      dragControls.start(event);
    }
  };

  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (shouldDismissRightSheet(info.offset.x, info.velocity.x, 360)) {
      setOpen(false);
    }
  };

  return (
    <DialogPrimitive.Root onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
        </TooltipTrigger>
        <TooltipContent side="right">{triggerTooltip}</TooltipContent>
      </Tooltip>
      <AnimatePresence>
        {open ? (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                animate={{ opacity: 1 }}
                className="fixed inset-0 z-40 bg-scrim"
                exit={{ opacity: 0 }}
                initial={{ opacity: 0 }}
                transition={{ duration: prefersReducedMotion ? 0.12 : 0.18 }}
              />
            </DialogPrimitive.Overlay>

            <DialogPrimitive.Content asChild forceMount>
              <motion.aside
                animate={{ opacity: 1, x: 0 }}
                className={cn(
                  "fixed inset-y-0 right-0 z-50 flex w-[min(90vw,22.5rem)] flex-col border-l border-border bg-surface/96 shadow-sheet backdrop-blur-xl focus:outline-none",
                  contentClassName,
                )}
                data-motion-reduced={prefersReducedMotion ? "true" : "false"}
                data-slot="sheet-content"
                data-ui="settings.view"
                drag={prefersReducedMotion ? false : "x"}
                dragConstraints={{ left: 0, right: 0 }}
                dragControls={dragControls}
                dragElastic={{ left: 0, right: 0.68 }}
                dragListener={false}
                dragMomentum={false}
                dragSnapToOrigin
                exit={{ opacity: 0, x: prefersReducedMotion ? 0 : "100%" }}
                initial={{ opacity: 0, x: prefersReducedMotion ? 0 : "100%" }}
                onDragEnd={handleDragEnd}
                transition={
                  prefersReducedMotion
                    ? { duration: 0.14, ease: "easeOut" }
                    : { type: "spring", bounce: 0, duration: 0.36 }
                }
              >
                <header
                  className="relative flex min-h-16 cursor-grab touch-none items-center border-b border-border px-5 active:cursor-grabbing"
                  onPointerDown={handleDragStart}
                >
                  <div className="min-w-0 pr-10">
                    <DialogPrimitive.Title className="truncate text-base font-semibold">
                      {title}
                    </DialogPrimitive.Title>
                    <DialogPrimitive.Description className="sr-only">
                      {description}
                    </DialogPrimitive.Description>
                  </div>

                  <span
                    aria-hidden="true"
                    className="absolute left-1/2 top-2 h-1 w-9 -translate-x-1/2 rounded-full bg-border"
                  />

                  <DialogPrimitive.Close asChild>
                    <Button
                      aria-label={closeLabel}
                      className="absolute right-3 top-3"
                      size="icon"
                      variant="ghost"
                    >
                      <X aria-hidden="true" className="size-4" />
                    </Button>
                  </DialogPrimitive.Close>
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">{children}</div>
              </motion.aside>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        ) : null}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

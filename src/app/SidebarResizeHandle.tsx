import { GripVertical } from "lucide-react";
import { animate, type AnimationPlaybackControls } from "motion";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type PointerEvent } from "react";

const STORAGE_KEY = "eternal-chat.sidebar-width";
const MIN_WIDTH = 208;
const MAX_WIDTH = 304;
const SNAP_POINTS = [208, 232, 264, 304] as const;

interface PointerSample {
  time: number;
  x: number;
}

export function SidebarResizeHandle() {
  const prefersReducedMotion = useReducedMotion();
  const [width, setWidth] = useState(readStoredWidth);
  const widthRef = useRef(width);
  const dragRef = useRef<{
    pointerId: number;
    startWidth: number;
    startX: number;
    samples: PointerSample[];
  } | null>(null);
  const animationRef = useRef<AnimationPlaybackControls | null>(null);

  useEffect(() => {
    applyWidth(width);
    widthRef.current = width;
  }, [width]);

  useEffect(() => () => animationRef.current?.stop(), []);

  const updateWidth = (next: number) => {
    widthRef.current = next;
    applyWidth(next);
    setWidth(next);
  };

  const settle = (velocity: number) => {
    const current = widthRef.current;
    const projected = current + project(velocity, 0.99);
    const target = nearestSnapPoint(projected);
    animationRef.current?.stop();
    if (prefersReducedMotion) {
      updateWidth(target);
      persistWidth(target);
      return;
    }
    animationRef.current = animate(current, target, {
      bounce: Math.abs(velocity) > 160 ? 0.16 : 0,
      duration: 0.36,
      onComplete: () => persistWidth(target),
      onUpdate: updateWidth,
      type: "spring",
      velocity,
    });
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    animationRef.current?.stop();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      samples: [{ time: event.timeStamp, x: event.clientX }],
      startWidth: widthRef.current,
      startX: event.clientX,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const raw = drag.startWidth + event.clientX - drag.startX;
    updateWidth(rubberbandWidth(raw));
    drag.samples.push({ time: event.timeStamp, x: event.clientX });
    if (drag.samples.length > 5) drag.samples.shift();
  };

  const finishPointer = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    settle(pointerVelocity(drag.samples));
  };

  return (
    <div
      aria-label="Resize conversation sidebar"
      aria-orientation="vertical"
      aria-valuemax={MAX_WIDTH}
      aria-valuemin={MIN_WIDTH}
      aria-valuenow={Math.round(width)}
      className="sidebar-resize-handle"
      data-ui="app.sidebar-resize"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const next = clamp(
            widthRef.current + (event.key === "ArrowLeft" ? -16 : 16),
            MIN_WIDTH,
            MAX_WIDTH,
          );
          updateWidth(next);
          persistWidth(next);
        }
      }}
      onPointerCancel={finishPointer}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      role="separator"
      tabIndex={0}
    >
      <GripVertical aria-hidden="true" className="size-3" />
    </div>
  );
}

function readStoredWidth(): number {
  const value = window.localStorage.getItem(STORAGE_KEY);
  if (value === null) return 232;
  const stored = Number(value);
  return Number.isFinite(stored) ? clamp(stored, MIN_WIDTH, MAX_WIDTH) : 232;
}

function applyWidth(width: number): void {
  document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
}

function persistWidth(width: number): void {
  window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
}

function pointerVelocity(samples: PointerSample[]): number {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || last.time <= first.time) return 0;
  return ((last.x - first.x) / (last.time - first.time)) * 1_000;
}

function project(velocity: number, decelerationRate: number): number {
  return (velocity / 1_000) * (decelerationRate / (1 - decelerationRate));
}

function nearestSnapPoint(value: number): number {
  return SNAP_POINTS.reduce((nearest, point) =>
    Math.abs(point - value) < Math.abs(nearest - value) ? point : nearest,
  );
}

function rubberbandWidth(value: number): number {
  if (value < MIN_WIDTH) {
    return MIN_WIDTH - rubberband(MIN_WIDTH - value, MAX_WIDTH - MIN_WIDTH);
  }
  if (value > MAX_WIDTH) {
    return MAX_WIDTH + rubberband(value - MAX_WIDTH, MAX_WIDTH - MIN_WIDTH);
  }
  return value;
}

function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

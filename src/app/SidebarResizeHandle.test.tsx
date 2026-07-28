import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidebarResizeHandle } from "@/app/SidebarResizeHandle";

const motionFixture = vi.hoisted(() => {
  const controls = { stop: vi.fn() };
  return {
    animate: vi.fn(
      (
        _from: number,
        to: number,
        options: {
          onComplete?: () => void;
          onUpdate?: (value: number) => void;
        },
      ) => {
        options.onUpdate?.(to);
        options.onComplete?.();
        return controls;
      },
    ),
    controls,
    reduced: false,
  };
});

vi.mock("motion", () => ({ animate: motionFixture.animate }));
vi.mock("motion/react", () => ({ useReducedMotion: () => motionFixture.reduced }));

afterEach(() => {
  motionFixture.animate.mockClear();
  motionFixture.controls.stop.mockClear();
  motionFixture.reduced = false;
});

describe("SidebarResizeHandle", () => {
  it("uses the documented default width and supports keyboard resizing", () => {
    render(<SidebarResizeHandle />);
    const handle = screen.getByRole("separator", { name: "Resize conversation sidebar" });

    expect(handle).toHaveAttribute("aria-valuenow", "232");
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe("232px");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "248");
    expect(window.localStorage.getItem("eternal-chat.sidebar-width")).toBe("248");
  });

  it("tracks the pointer 1:1 and passes release velocity into the spring", () => {
    render(<SidebarResizeHandle />);
    const handle = screen.getByRole("separator", { name: "Resize conversation sidebar" });

    firePointer(handle, "pointerDown", { button: 0, clientX: 100, pointerId: 7 }, 100);
    firePointer(handle, "pointerMove", { clientX: 140, pointerId: 7 }, 110);
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe("272px");
    firePointer(handle, "pointerUp", { clientX: 140, pointerId: 7 }, 110);

    expect(motionFixture.animate).toHaveBeenCalledWith(
      272,
      304,
      expect.objectContaining({
        bounce: 0.16,
        duration: 0.36,
        type: "spring",
        velocity: 4_000,
      }),
    );
    expect(window.localStorage.getItem("eternal-chat.sidebar-width")).toBe("304");
  });

  it("settles immediately when reduced motion is requested and stops animation on unmount", () => {
    motionFixture.reduced = true;
    const { unmount } = render(<SidebarResizeHandle />);
    const handle = screen.getByRole("separator", { name: "Resize conversation sidebar" });

    firePointer(handle, "pointerDown", { button: 0, clientX: 100, pointerId: 9 }, 100);
    firePointer(handle, "pointerMove", { clientX: 132, pointerId: 9 }, 100);
    firePointer(handle, "pointerUp", { clientX: 132, pointerId: 9 }, 100);
    expect(motionFixture.animate).not.toHaveBeenCalled();
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe("264px");
    expect(window.localStorage.getItem("eternal-chat.sidebar-width")).toBe("264");

    unmount();

    motionFixture.reduced = false;
    const standard = render(<SidebarResizeHandle />);
    const standardHandle = screen.getByRole("separator", {
      name: "Resize conversation sidebar",
    });
    firePointer(standardHandle, "pointerDown", { button: 0, clientX: 100, pointerId: 10 }, 200);
    firePointer(standardHandle, "pointerUp", { clientX: 100, pointerId: 10 }, 200);
    expect(motionFixture.animate).toHaveBeenCalled();
    standard.unmount();
    expect(motionFixture.controls.stop).toHaveBeenCalled();
  });
});

function firePointer(
  element: Element,
  type: "pointerDown" | "pointerMove" | "pointerUp",
  init: PointerEventInit,
  timeStamp: number,
): void {
  const event = createEvent[type](element, init);
  Object.defineProperty(event, "timeStamp", { configurable: true, value: timeStamp });
  fireEvent(element, event);
}

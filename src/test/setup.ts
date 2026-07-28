import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";

configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
  if (typeof window !== "undefined") {
    window.localStorage.clear();
    document.documentElement.className = "";
    delete document.documentElement.dataset.theme;
    document.documentElement.style.removeProperty("--sidebar-width");
  }
});

if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
    writable: true,
  });

  Object.defineProperty(Element.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });

  Object.defineProperty(Element.prototype, "releasePointerCapture", {
    configurable: true,
    value: vi.fn(),
  });

  Object.defineProperty(Element.prototype, "hasPointerCapture", {
    configurable: true,
    value: vi.fn().mockReturnValue(true),
  });

  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });

  for (const method of ["scroll", "scrollBy", "scrollTo"] as const) {
    Object.defineProperty(HTMLElement.prototype, method, {
      configurable: true,
      value: vi.fn(),
    });
  }

  class ResizeObserverMock {
    constructor(private readonly callback: ResizeObserverCallback) {}

    disconnect() {}

    observe(target: Element) {
      const isVirtualViewport =
        target.classList.contains("message-virtual-list") ||
        target.parentElement?.classList.contains("message-virtual-list");
      const contentRect = new DOMRect(0, 0, 800, isVirtualViewport ? 640 : 132);
      queueMicrotask(() => {
        if (!target.isConnected) return;
        this.callback(
          [
            {
              borderBoxSize: [],
              contentBoxSize: [],
              contentRect,
              devicePixelContentBoxSize: [],
              target,
            } as unknown as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      });
    }

    unobserve() {}
  }

  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock,
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock,
  });
}

import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.className = "";
  delete document.documentElement.dataset.theme;
});

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

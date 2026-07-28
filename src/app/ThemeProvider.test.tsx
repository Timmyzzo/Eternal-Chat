import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@/app/ThemeProvider";

describe("ThemeProvider", () => {
  it("removes its system-theme listener when unmounted", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const media = {
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener,
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } satisfies MediaQueryList;
    vi.spyOn(window, "matchMedia").mockReturnValue(media);

    const view = render(
      <ThemeProvider>
        <div>Theme fixture</div>
      </ThemeProvider>,
    );
    const listener = addEventListener.mock.calls[0]?.[1];

    expect(addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    view.unmount();
    expect(removeEventListener).toHaveBeenCalledWith("change", listener);
  });
});

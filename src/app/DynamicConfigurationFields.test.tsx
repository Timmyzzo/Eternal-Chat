import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DynamicCapabilityFields } from "@/app/DynamicConfigurationFields";

describe("Phase 6 dynamic capability fields", () => {
  it("renders official and custom capabilities without treating unknown as unsupported", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DynamicCapabilityFields
        capabilities={{
          reasoning: { state: "reported", value: true, userEdited: false },
          custom: {
            future_input: {
              state: "unknown",
              value: ["future"],
              userEdited: false,
            },
          },
        }}
        onChange={onChange}
      />,
    );

    expect(screen.getByText("reasoning")).toBeInTheDocument();
    expect(screen.getByText("custom.future_input")).toBeInTheDocument();
    expect(screen.getByLabelText("custom.future_input state")).toHaveValue("unknown");
    await user.selectOptions(screen.getByLabelText("custom.future_input state"), "verified");
    expect(onChange).toHaveBeenCalledWith("custom.future_input", {
      state: "verified",
      value: ["future"],
      userEdited: true,
    });
  });
});

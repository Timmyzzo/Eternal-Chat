import { describe, expect, it } from "vitest";

import {
  validateCapabilityCatalog,
  validateParameterCatalog,
  validateToolCatalog,
} from "@/application/providers/configurationSchema";

describe("Phase 6 configuration schema validation", () => {
  it("validates capability entries while preserving custom and future capability ids", () => {
    expect(
      validateCapabilityCatalog({
        reasoning: { state: "reported", value: true, userEdited: false },
        custom: {
          future_modality: {
            state: "unknown",
            value: ["future-input"],
            userEdited: true,
            future_schema_key: "preserved",
          },
        },
      }),
    ).toMatchObject({
      reasoning: { state: "reported", value: true },
      custom: {
        future_modality: {
          state: "unknown",
          value: ["future-input"],
          future_schema_key: "preserved",
        },
      },
    });

    expect(() =>
      validateCapabilityCatalog({
        reasoning: { state: "assumed", value: true, userEdited: false },
      }),
    ).toThrow(/Capability reasoning state is invalid/);
  });

  it("accepts unknown custom values and fields while preserving the declared wire path", () => {
    expect(
      validateParameterCatalog([
        {
          id: "future_effort",
          label: "Future effort",
          semanticHint: "custom",
          placement: "body",
          path: "custom.deep.reasoningEffort",
          type: "select",
          options: [{ label: "Future", value: "future-ultra", vendor_note: "preserved" }],
          allowCustomValue: true,
          future_schema_key: { retained: true },
        },
      ])[0],
    ).toMatchObject({
      id: "future_effort",
      path: "custom.deep.reasoningEffort",
      allowCustomValue: true,
      future_schema_key: { retained: true },
    });
  });

  it("rejects duplicate ids, empty paths, and malformed tool descriptors", () => {
    expect(() =>
      validateParameterCatalog([
        {
          id: "effort",
          label: "Effort",
          placement: "body",
          path: "reasoning.effort",
          type: "string",
          allowCustomValue: true,
        },
        {
          id: "effort",
          label: "Duplicate",
          placement: "body",
          path: "",
          type: "string",
          allowCustomValue: true,
        },
      ]),
    ).toThrow(/Duplicate parameter id: effort/);
    expect(() =>
      validateParameterCatalog([
        {
          id: "empty",
          label: "Empty",
          placement: "body",
          path: " ",
          type: "string",
          allowCustomValue: true,
        },
      ]),
    ).toThrow(/wire path is empty/);
    expect(() =>
      validateToolCatalog([
        {
          id: "broken",
          label: "Broken",
          modeOptions: ["off", "auto"],
          descriptor: [],
          paramsSchema: [],
          userEdited: false,
        },
      ]),
    ).toThrow(/descriptor must be an object/);
  });
});

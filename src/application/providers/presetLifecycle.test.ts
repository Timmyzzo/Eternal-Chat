import { describe, expect, it } from "vitest";

import {
  createTrackedPresetBinding,
  projectTrackedPreset,
} from "@/application/providers/presetLifecycle";

describe("Phase 6 preset lifecycle", () => {
  it("records only user overrides and reapplies them over a newer preset revision", () => {
    const base = {
      endpoint: {
        baseUrl: "https://api.example.invalid",
        pathTemplate: "/v1/responses",
      },
      modelId: "model-v1",
      parameterValues: { effort: "high" },
      tools: [{ id: "search", descriptor: { type: "web_search" } }],
    };
    const current = {
      ...base,
      endpoint: { ...base.endpoint, pathTemplate: "/proxy/v1/responses" },
      parameterValues: { effort: "xhigh" },
    };

    const binding = createTrackedPresetBinding("preset-a", 1, base, current);
    expect(binding.overridePatch).toEqual({
      endpoint: { pathTemplate: "/proxy/v1/responses" },
      parameterValues: { effort: "xhigh" },
    });

    expect(
      projectTrackedPreset(
        {
          endpoint: {
            baseUrl: "https://api-v2.example.invalid",
            pathTemplate: "/v2/responses",
          },
          modelId: "model-v2",
          parameterValues: { effort: "medium", futureDefault: true },
          tools: [{ id: "search", descriptor: { type: "web_search_v2" } }],
        },
        binding,
      ),
    ).toEqual({
      endpoint: {
        baseUrl: "https://api-v2.example.invalid",
        pathTemplate: "/proxy/v1/responses",
      },
      modelId: "model-v2",
      parameterValues: { effort: "xhigh", futureDefault: true },
      tools: [{ id: "search", descriptor: { type: "web_search_v2" } }],
    });
  });
});

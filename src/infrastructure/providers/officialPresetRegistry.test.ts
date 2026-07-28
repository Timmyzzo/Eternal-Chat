import { describe, expect, it } from "vitest";

import {
  OFFICIAL_PRESET_REGISTRY,
  createOfficialProtocolPresets,
  findOfficialModelPreset,
} from "@/infrastructure/providers/officialPresetRegistry";
import {
  detachPreset,
  projectTrackedPreset,
  resetTrackedPreset,
} from "@/application/providers/presetLifecycle";

describe("Phase 6 official preset registry", () => {
  it("keeps provider endpoints and reasoning paths protocol-specific", () => {
    expect(OFFICIAL_PRESET_REGISTRY.checkedAt).toBe("2026-07-28");
    expect(OFFICIAL_PRESET_REGISTRY.revision).toBeGreaterThan(0);

    const protocols = createOfficialProtocolPresets(123);
    expect(protocols.map((profile) => profile.codecId)).toEqual([
      "openai_chat_completions",
      "openai_responses",
      "anthropic_messages",
      "gemini_generate_content",
      "gemini_interactions",
    ]);
    expect(protocols.every((profile) => profile.source !== null)).toBe(true);
    expect(protocols.every((profile) => profile.presetBinding?.mode === "tracked")).toBe(true);

    const expected = [
      ["openai-chat", "/v1/chat/completions", "reasoning_effort"],
      ["openai-responses", "/v1/responses", "reasoning.effort"],
      ["xai-responses", "/v1/responses", "reasoning.effort"],
      [
        "gemini-generate-content",
        "/v1beta/{+model}:streamGenerateContent",
        "generationConfig.thinkingConfig.thinkingLevel",
      ],
      ["gemini-interactions", "/v1beta/interactions", "generation_config.thinking_level"],
      ["anthropic-messages", "/v1/messages", "output_config.effort"],
    ] as const;

    for (const [presetId, path, reasoningPath] of expected) {
      const preset = findOfficialModelPreset(presetId);
      expect(preset.endpoint.pathTemplate).toBe(path);
      expect(preset.parameters.some((parameter) => parameter.path === reasoningPath)).toBe(true);
      expect(preset.source.sourceUrl).toMatch(/^https:\/\//);
      expect(preset.endpoint.requestFields.length).toBeGreaterThan(0);
      expect(
        preset.endpoint.requestFields.every(
          (field) =>
            field.endpoint === path &&
            field.path.length > 0 &&
            field.sourceUrl === preset.source.sourceUrl &&
            field.checkedAt === preset.source.checkedAt &&
            field.revision === preset.source.revision,
        ),
      ).toBe(true);
    }

    expect(findOfficialModelPreset("gemini-generate-content").endpoint.requestFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ location: "path", path: "model", type: "string" }),
        expect.objectContaining({ location: "body", path: "generationConfig" }),
      ]),
    );
  });

  it("keeps Grok xhigh and provider tool descriptors without cross-protocol translation", () => {
    const grok = findOfficialModelPreset("xai-responses");
    expect(grok.parameters.find((parameter) => parameter.id === "reasoning_effort")).toMatchObject({
      allowCustomValue: true,
      options: expect.arrayContaining([expect.objectContaining({ value: "xhigh" })]),
      path: "reasoning.effort",
    });
    expect(grok.tools.map((tool) => tool.descriptor)).toEqual([
      { type: "web_search" },
      { type: "x_search" },
    ]);

    expect(findOfficialModelPreset("gemini-generate-content").tools[0]?.descriptor).toEqual({
      googleSearch: {},
    });
    expect(findOfficialModelPreset("anthropic-messages").tools[0]?.descriptor).toEqual({
      type: "web_search_20250305",
      name: "web_search",
    });
  });
});

describe("Phase 6 preset ownership", () => {
  const official = {
    schema: { effort: "high", nested: { newField: true, retained: "official" } },
    tools: ["web_search"],
  };

  it("updates tracked presets while retaining overrides and freezes detached forks", () => {
    const binding = {
      mode: "tracked" as const,
      presetId: "preset.fixture",
      baseRevision: 1,
      overridePatch: { schema: { nested: { retained: "user" } }, tools: ["custom"] },
    };
    expect(projectTrackedPreset(official, binding)).toEqual({
      schema: { effort: "high", nested: { newField: true, retained: "user" } },
      tools: ["custom"],
    });

    const detached = detachPreset(projectTrackedPreset(official, binding), binding);
    expect(detached.binding).toEqual({
      mode: "detached",
      forkedFromPresetId: "preset.fixture",
      forkedFromRevision: 1,
    });
    expect(detached.value).toEqual(projectTrackedPreset(official, binding));

    const upgradedOfficial = {
      schema: { effort: "xhigh", nested: { newField: false, retained: "next" } },
      tools: ["web_search", "x_search"],
    };
    expect(projectTrackedPreset(upgradedOfficial, binding).schema).toEqual({
      effort: "xhigh",
      nested: { newField: false, retained: "user" },
    });
    expect(detached.value).not.toEqual(projectTrackedPreset(upgradedOfficial, binding));
    expect(resetTrackedPreset("preset.fixture", 2)).toEqual({
      mode: "tracked",
      presetId: "preset.fixture",
      baseRevision: 2,
      overridePatch: {},
    });
  });
});

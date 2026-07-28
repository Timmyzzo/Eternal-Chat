// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  applyMigrations,
  createTempDatabase,
  PHASE_3_MIGRATION,
  PHASE_5A_MIGRATION,
  PHASE_6_MIGRATION,
} from "@/test/database/tempDatabase";

describe("Phase 6 migration", () => {
  it("adds configuration ownership and path columns without rewriting v1 or v2", async () => {
    const fixture = await createTempDatabase([PHASE_3_MIGRATION, PHASE_5A_MIGRATION]);
    try {
      const previous = await fixture.database.select<{
        checksum: string;
        name: string;
        version: number;
      }>("SELECT version, name, checksum FROM schema_migration ORDER BY version");

      await fixture.database.execute(
        "INSERT INTO provider_connection (id, name, enabled, created_at, updated_at) VALUES (?, ?, 1, 1, 1)",
        ["legacy-connection", "Legacy connection"],
      );
      await fixture.database.execute(
        `INSERT INTO protocol_profile (
          id, name, codec_id, request_mapping_json, response_mapping_json,
          tools_mapping_json, user_edited, revision, created_at, updated_at
        ) VALUES (?, ?, ?, '{}', '{}', '{}', 0, 1, 1, 1)`,
        ["legacy-profile", "Legacy profile", "openai_responses"],
      );
      await fixture.database.execute(
        `INSERT INTO provider_endpoint (
          id, connection_id, name, base_url, path_template, protocol_profile_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
        [
          "legacy-endpoint",
          "legacy-connection",
          "Legacy endpoint",
          "https://fixture.invalid",
          "/v1/responses",
          "legacy-profile",
        ],
      );
      await fixture.database.execute(
        `INSERT INTO model (
          id, endpoint_id, model_id, display_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, 1)`,
        ["legacy-model", "legacy-endpoint", "legacy-model-id", "Legacy model"],
      );
      await fixture.database.execute(
        `INSERT INTO conversation (
          id, title, model_ref, created_at, updated_at
        ) VALUES (?, ?, ?, 1, 1)`,
        ["legacy-conversation", "Legacy conversation", "legacy-model"],
      );

      applyMigrations(fixture.database, [PHASE_3_MIGRATION, PHASE_5A_MIGRATION, PHASE_6_MIGRATION]);

      expect(
        await fixture.database.select<{ checksum: string; name: string; version: number }>(
          "SELECT version, name, checksum FROM schema_migration ORDER BY version",
        ),
      ).toEqual([
        ...previous,
        {
          version: 3,
          name: "phase_6_provider_configuration",
          checksum: PHASE_6_MIGRATION.checksum,
        },
      ]);
      expect(
        await fixture.database.select<{
          path_defaults_json: string;
          preset_binding_json: string | null;
          source_json: string | null;
        }>(
          "SELECT path_defaults_json, source_json, preset_binding_json FROM provider_endpoint WHERE id = ?",
          ["legacy-endpoint"],
        ),
      ).toEqual([{ path_defaults_json: "{}", source_json: null, preset_binding_json: null }]);
      expect(
        await fixture.database.select<{
          extra_path_json: string;
          parameter_values_json: string;
          preset_binding_json: string | null;
          source_json: string | null;
          tool_settings_json: string;
        }>(
          `SELECT parameter_values_json, tool_settings_json, extra_path_json,
            source_json, preset_binding_json FROM model WHERE id = ?`,
          ["legacy-model"],
        ),
      ).toEqual([
        {
          parameter_values_json: "{}",
          tool_settings_json: "{}",
          extra_path_json: "{}",
          source_json: null,
          preset_binding_json: null,
        },
      ]);
      expect(
        await fixture.database.select<{ extra_path_json: string }>(
          "SELECT extra_path_json FROM conversation WHERE id = ?",
          ["legacy-conversation"],
        ),
      ).toEqual([{ extra_path_json: "{}" }]);
    } finally {
      await fixture.cleanup();
    }
  });
});

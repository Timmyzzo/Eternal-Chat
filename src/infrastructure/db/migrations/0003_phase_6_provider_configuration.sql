ALTER TABLE protocol_profile
ADD COLUMN preset_binding_json TEXT CHECK (
  preset_binding_json IS NULL OR json_valid(preset_binding_json)
);

ALTER TABLE provider_endpoint
ADD COLUMN path_defaults_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(path_defaults_json));

ALTER TABLE provider_endpoint
ADD COLUMN source_json TEXT CHECK (source_json IS NULL OR json_valid(source_json));

ALTER TABLE provider_endpoint
ADD COLUMN preset_binding_json TEXT CHECK (
  preset_binding_json IS NULL OR json_valid(preset_binding_json)
);

ALTER TABLE model
ADD COLUMN parameter_values_json TEXT NOT NULL DEFAULT '{}' CHECK (
  json_valid(parameter_values_json)
);

ALTER TABLE model
ADD COLUMN tool_settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(tool_settings_json));

ALTER TABLE model
ADD COLUMN extra_path_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_path_json));

ALTER TABLE model
ADD COLUMN source_json TEXT CHECK (source_json IS NULL OR json_valid(source_json));

ALTER TABLE model
ADD COLUMN preset_binding_json TEXT CHECK (
  preset_binding_json IS NULL OR json_valid(preset_binding_json)
);

ALTER TABLE conversation
ADD COLUMN extra_path_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_path_json));

INSERT INTO schema_migration (version, name, applied_at, checksum)
VALUES (
  3,
  'phase_6_provider_configuration',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  'sha256:05286a7302da65f4c18531b756bbb24dab316d9135a53934d18ad76821296a51'
);

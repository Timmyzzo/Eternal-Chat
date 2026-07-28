mod pipeline;

use tauri_plugin_sql::{Migration, MigrationKind};

const DATABASE_URL: &str = "sqlite:eternal-chat.db";

fn database_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "phase_3_authoritative_schema",
            sql: include_str!(
                "../../src/infrastructure/db/migrations/0001_phase_3_authoritative_schema.sql"
            ),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "phase_5a_request_attempts",
            sql: include_str!(
                "../../src/infrastructure/db/migrations/0002_phase_5a_request_attempts.sql"
            ),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "phase_6_provider_configuration",
            sql: include_str!(
                "../../src/infrastructure/db/migrations/0003_phase_6_provider_configuration.sql"
            ),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DATABASE_URL, database_migrations())
                .build(),
        )
        .manage(pipeline::Pipeline::default())
        .invoke_handler(tauri::generate_handler![
            pipeline::start_stream,
            pipeline::cancel_stream
        ])
        .run(tauri::generate_context!())
        .expect("error while running Eternal Chat");
}

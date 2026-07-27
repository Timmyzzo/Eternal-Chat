mod pipeline;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(pipeline::Pipeline::default())
        .invoke_handler(tauri::generate_handler![
            pipeline::start_stream,
            pipeline::cancel_stream
        ])
        .run(tauri::generate_context!())
        .expect("error while running Eternal Chat");
}

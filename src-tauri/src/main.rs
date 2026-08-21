// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mode = main::desktop::mode::current();
    main::desktop::mode::set_app_user_model_id(&mode);
    main::run()
}

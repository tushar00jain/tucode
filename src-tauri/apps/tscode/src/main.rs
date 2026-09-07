// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `generate_context!` bakes in the `tauri.conf.json` of the package it is compiled in.
    tscode_app::run(tauri::generate_context!());
}

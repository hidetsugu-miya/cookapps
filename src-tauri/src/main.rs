// Without this a Windows release build opens a console window next to the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cookup_lib::run();
}

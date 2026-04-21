#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    accessbridge_desktop_agent::run();
}

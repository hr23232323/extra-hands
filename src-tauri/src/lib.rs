use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, Runtime,
};
use tauri_plugin_store::StoreExt;

const WINDOW_WIDTH: f64 = 480.0;
const PADDING: f64 = 8.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Prefs {
    model:     Option<String>,
    theme:     Option<String>,
    workspace: Option<String>,
}

#[tauri::command]
fn get_api_key(app: tauri::AppHandle) -> Option<String> {
    let store = app.store("store.json").ok()?;
    store
        .get("api_key")
        .and_then(|v| v.as_str().map(String::from))
}

#[tauri::command]
fn set_api_key(app: tauri::AppHandle, key: String) {
    if let Ok(store) = app.store("store.json") {
        store.set("api_key", serde_json::Value::String(key));
        let _ = store.save();
    }
}

#[tauri::command]
fn get_prefs(app: tauri::AppHandle) -> Prefs {
    if let Ok(store) = app.store("store.json") {
        if let Some(v) = store.get("prefs") {
            if let Ok(prefs) = serde_json::from_value::<Prefs>(v.clone()) {
                return prefs;
            }
        }
    }
    Prefs { model: None, theme: None, workspace: None }
}

#[tauri::command]
fn set_prefs(app: tauri::AppHandle, prefs: Prefs) {
    if let Ok(store) = app.store("store.json") {
        store.set("prefs", serde_json::to_value(&prefs).unwrap());
        let _ = store.save();
    }
}

#[tauri::command]
fn get_threads(app: tauri::AppHandle) -> serde_json::Value {
    if let Ok(store) = app.store("store.json") {
        if let Some(v) = store.get("threads") {
            return v.clone();
        }
    }
    serde_json::Value::Array(vec![])
}

#[tauri::command]
fn set_threads(app: tauri::AppHandle, threads: serde_json::Value) {
    if let Ok(store) = app.store("store.json") {
        store.set("threads", threads);
        let _ = store.save();
    }
}

fn toggle_window<R: Runtime>(app: &tauri::AppHandle<R>, tray_rect: &tauri::Rect) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let (tray_x, tray_y, tray_width, tray_height) =
                match (&tray_rect.position, &tray_rect.size) {
                    (tauri::Position::Physical(pos), tauri::Size::Physical(size)) => (
                        pos.x as f64,
                        pos.y as f64,
                        size.width as f64,
                        size.height as f64,
                    ),
                    (tauri::Position::Logical(pos), tauri::Size::Logical(size)) => {
                        (pos.x, pos.y, size.width, size.height)
                    }
                    _ => (0.0, 0.0, 0.0, 0.0),
                };

            let tray_center_x = tray_x + (tray_width / 2.0);
            let tray_bottom_y = tray_y + tray_height;
            let window_x = tray_center_x - (WINDOW_WIDTH / 2.0);
            let window_y = tray_bottom_y + PADDING;

            let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: window_x as i32,
                y: window_y as i32,
            }));
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_api_key,
            set_api_key,
            get_prefs,
            set_prefs,
            get_threads,
            set_threads,
        ])
        .setup(|app| {
            let _ = app.store("store.json")?;

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
                .expect("tray icon missing");

            let handle = app.handle().clone();
            TrayIconBuilder::with_id("main")
                .icon(icon)
                .icon_as_template(true)
                .on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        toggle_window(&handle, &rect);
                    }
                })
                .build(app)?;

            let window = app.get_webview_window("main").unwrap();
            window.on_window_event({
                let window = window.clone();
                move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        let _ = window.hide();
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

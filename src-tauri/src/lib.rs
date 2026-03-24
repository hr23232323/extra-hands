use serde::{Deserialize, Serialize};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, Runtime,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_store::StoreExt;

struct DialogOpen(Arc<AtomicBool>);

const WINDOW_WIDTH: f64 = 480.0;
const PADDING: f64 = 8.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prefs {
    model:           Option<String>,
    theme:           Option<String>,
    workspace:       Option<String>,
    trusted_folders: Option<Vec<String>>,
}

fn get_secure_key(app: &tauri::AppHandle, store_key: &str) -> Option<String> {
    let store = app.store("store.json").ok()?;
    store.get(store_key).and_then(|v| v.as_str().map(String::from))
}

fn set_secure_key(app: &tauri::AppHandle, store_key: &str, key: String) {
    if let Ok(store) = app.store("store.json") {
        store.set(store_key, serde_json::Value::String(key));
        let _ = store.save();
    }
}

#[tauri::command]
fn get_api_key(app: tauri::AppHandle) -> Option<String> { get_secure_key(&app, "api_key") }
#[tauri::command]
fn set_api_key(app: tauri::AppHandle, key: String) { set_secure_key(&app, "api_key", key); }

#[tauri::command]
fn get_tavily_key(app: tauri::AppHandle) -> Option<String> { get_secure_key(&app, "tavily_key") }
#[tauri::command]
fn set_tavily_key(app: tauri::AppHandle, key: String) { set_secure_key(&app, "tavily_key", key); }

#[tauri::command]
fn get_jina_key(app: tauri::AppHandle) -> Option<String> { get_secure_key(&app, "jina_key") }
#[tauri::command]
fn set_jina_key(app: tauri::AppHandle, key: String) { set_secure_key(&app, "jina_key", key); }

#[tauri::command]
fn get_prefs(app: tauri::AppHandle) -> Prefs {
    if let Ok(store) = app.store("store.json") {
        if let Some(v) = store.get("prefs") {
            if let Ok(prefs) = serde_json::from_value::<Prefs>(v.clone()) {
                return prefs;
            }
        }
    }
    Prefs { model: None, theme: None, workspace: None, trusted_folders: None }
}

#[tauri::command]
fn set_prefs(app: tauri::AppHandle, prefs: Prefs) {
    if let Ok(store) = app.store("store.json") {
        store.set("prefs", serde_json::to_value(&prefs).unwrap());
        let _ = store.save();
    }
}

// ── Thread index (lightweight metadata only) ──────────────────────────────────

#[tauri::command]
fn get_thread_index(app: tauri::AppHandle) -> serde_json::Value {
    if let Ok(store) = app.store("store.json") {
        if let Some(v) = store.get("thread_index") {
            return v.clone();
        }
    }
    serde_json::Value::Array(vec![])
}

#[tauri::command]
fn set_thread_index(app: tauri::AppHandle, index: serde_json::Value) {
    if let Ok(store) = app.store("store.json") {
        store.set("thread_index", index);
        let _ = store.save();
    }
}

// ── Per-thread content (full messages, one file each) ─────────────────────────

fn thread_store_name(id: &str) -> String {
    format!("thread-{}.json", id)
}

#[tauri::command]
fn get_thread(app: tauri::AppHandle, id: String) -> serde_json::Value {
    let store_name = thread_store_name(&id);
    if let Ok(store) = app.store(&store_name) {
        if let Some(v) = store.get("data") {
            return v.clone();
        }
    }
    serde_json::Value::Null
}

#[tauri::command]
fn save_thread(app: tauri::AppHandle, id: String, thread: serde_json::Value) {
    let store_name = thread_store_name(&id);
    if let Ok(store) = app.store(&store_name) {
        store.set("data", thread);
        let _ = store.save();
    }
}

// ── File tools ────────────────────────────────────────────────────────────────

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    app.state::<DialogOpen>().0.store(true, Ordering::Relaxed);
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .pick_folder(move |folder| { let _ = tx.send(folder); });
    let result = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten()
        .map(|f| f.to_string());
    app.state::<DialogOpen>().0.store(false, Ordering::Relaxed);
    result
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<serde_json::Value>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    Ok(entries
        .filter_map(|e| e.ok())
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            serde_json::json!({ "name": name, "is_dir": is_dir })
        })
        .collect())
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_api_key,
            set_api_key,
            get_tavily_key,
            set_tavily_key,
            get_jina_key,
            set_jina_key,
            get_prefs,
            set_prefs,
            get_thread_index,
            set_thread_index,
            get_thread,
            save_thread,
            pick_folder,
            list_dir,
            read_file,
            write_file,
            open_path,
        ])
        .setup(|app| {
            let _ = app.store("store.json")?;
            app.manage(DialogOpen(Arc::new(AtomicBool::new(false))));

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
            let dialog_open = app.state::<DialogOpen>().0.clone();
            window.on_window_event({
                let window = window.clone();
                move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        if !dialog_open.load(Ordering::Relaxed) {
                            let _ = window.hide();
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

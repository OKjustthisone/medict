#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, path::PathBuf, process::Command, sync::Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State, Window};

mod drug_lookup;
mod word_lookup;

struct AppState {
    settings: Mutex<Value>,
    settings_path: PathBuf,
}

fn default_settings() -> Value {
    json!({
        "behavior": {
            "selectionLookup": false,
            "selectionMaxLength": 500
        },
        "shortcuts": {
            "showWindow": "CommandOrControl+Alt+M",
            "selectionLookup": "Alt+D"
        },
        "dictionary": {
            "youdaoDictionary": { "enabled": true },
            "freeDictionary": { "enabled": true },
            "baidu": { "enabled": false, "apiKey": "", "secretKey": "" },
            "serviceOrder": ["youdaoDictionary", "freeDictionary", "baidu", "google"]
        },
        "translation": {
            "source": "auto",
            "target": "zh-CN",
            "google": { "enabled": false, "mode": "web", "apiKey": "" },
            "baidu": { "enabled": false, "apiKey": "", "secretKey": "" }
        },
        "appearance": { "fontScale": 115 },
        "window": { "alwaysOnTop": false, "hideOnClose": true }
    })
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("settings.json"))
}

fn load_settings(path: &PathBuf) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_else(default_settings)
}

fn write_settings(path: &PathBuf, value: &Value) -> Result<(), String> {
    let contents = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn migration_warning(feature: &str) -> String {
    format!("Tauri 迁移骨架尚未迁移 {feature}；当前响应仅用于验证 UI 和命令边界")
}

#[tauri::command]
fn app_metadata(app: AppHandle) -> Value {
    json!({
        "name": "Medict Tauri",
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "userData": settings_path(&app).ok().and_then(|path| path.parent().map(|value| value.to_string_lossy().to_string())),
        "migration": true
    })
}

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> Result<Value, String> {
    state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "设置状态锁定失败".to_string())
}

#[tauri::command]
fn settings_save(state: State<'_, AppState>, value: Value) -> Result<Value, String> {
    write_settings(&state.settings_path, &value)?;
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "设置状态锁定失败".to_string())?;
    *settings = value.clone();
    Ok(value)
}

#[tauri::command]
fn settings_set_language_pair(state: State<'_, AppState>, value: Value) -> Result<Value, String> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "设置状态锁定失败".to_string())?;
    let source = value
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    let target = value
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or("zh-CN");
    settings["translation"]["source"] = json!(source);
    settings["translation"]["target"] = json!(target);
    write_settings(&state.settings_path, &settings)?;
    Ok(settings.clone())
}

fn lookup_config(state: &State<'_, AppState>) -> Result<word_lookup::LookupConfig, String> {
    state
        .settings
        .lock()
        .map(|settings| {
            let dictionary = settings.get("dictionary");
            let youdao_enabled = dictionary
                .and_then(|value| value.get("youdaoDictionary"))
                .and_then(|service| service.get("enabled"))
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let free_dictionary_enabled = dictionary
                .and_then(|value| value.get("freeDictionary"))
                .and_then(|service| service.get("enabled"))
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let service_order = dictionary
                .and_then(|value| value.get("serviceOrder"))
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToString::to_string)
                        .collect()
                })
                .unwrap_or_else(|| {
                    vec!["youdaoDictionary".to_string(), "freeDictionary".to_string()]
                });
            word_lookup::LookupConfig {
                youdao_enabled,
                free_dictionary_enabled,
                service_order,
            }
        })
        .map_err(|_| "读取词典服务设置失败".to_string())
}

#[tauri::command]
async fn lookup_word(
    state: State<'_, AppState>,
    query: String,
    _options: Value,
) -> Result<Value, String> {
    let config = lookup_config(&state)?;
    word_lookup::lookup_word(&query, config).await
}

#[tauri::command]
async fn lookup_selection(state: State<'_, AppState>, query: String) -> Result<Value, String> {
    let config = lookup_config(&state)?;
    word_lookup::lookup_word(&query, config).await
}

#[tauri::command]
async fn lookup_drug(query: String) -> Result<Value, String> {
    drug_lookup::lookup_drug(&query).await
}

#[tauri::command]
fn selection_status() -> Value {
    json!({
        "available": false,
        "active": false,
        "message": "Tauri 迁移骨架尚未接入 Windows 划词助手"
    })
}

#[tauri::command]
fn shortcuts_suspend() -> bool {
    false
}

#[tauri::command]
fn shortcuts_resume() -> bool {
    false
}

#[tauri::command]
fn drug_cache_stats() -> Value {
    json!({ "count": 0, "ttlMs": 604800000, "migration": true })
}

#[tauri::command]
fn clipboard_write_text(_value: String) -> bool {
    // The frontend uses navigator.clipboard first. This command remains a
    // stable placeholder until a Tauri clipboard plugin is selected.
    true
}

#[tauri::command]
fn window_minimize(window: Window) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_hide(window: Window) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_toggle_pin(window: Window) -> Result<bool, String> {
    let next = !window
        .is_always_on_top()
        .map_err(|error| error.to_string())?;
    window
        .set_always_on_top(next)
        .map_err(|error| error.to_string())?;
    Ok(next)
}

#[tauri::command]
fn window_is_pinned(window: Window) -> Result<bool, String> {
    window.is_always_on_top().map_err(|error| error.to_string())
}

#[tauri::command]
fn app_quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("只允许打开 http/https 链接".to_string());
    }

    #[cfg(target_os = "windows")]
    let result = Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url.as_str()])
        .spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(url.as_str()).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(url.as_str()).spawn();

    result.map(|_| ()).map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let path = settings_path(app.handle())?;
            let settings = load_settings(&path);
            app.manage(AppState {
                settings: Mutex::new(settings),
                settings_path: path,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_metadata,
            settings_get,
            settings_save,
            settings_set_language_pair,
            lookup_word,
            lookup_selection,
            lookup_drug,
            selection_status,
            shortcuts_suspend,
            shortcuts_resume,
            drug_cache_stats,
            clipboard_write_text,
            window_minimize,
            window_hide,
            window_toggle_pin,
            window_is_pinned,
            app_quit,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running Medict Tauri");
}

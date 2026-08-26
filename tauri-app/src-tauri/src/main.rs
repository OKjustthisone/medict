#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use medict_core::{drug_lookup, word_lookup};
use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, State, WebviewWindowBuilder, Window, WindowEvent,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

struct AppState {
    settings: Mutex<Value>,
    settings_path: PathBuf,
    window_lifecycle: Mutex<()>,
    keep_alive_after_window_destroy: AtomicBool,
    selection_process: Mutex<Option<Child>>,
    selection_request_id: AtomicU64,
    hotkey_runtime: Mutex<Option<HotkeyRuntime>>,
}

struct HotkeyRuntime {
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: JoinHandle<()>,
}

fn default_settings() -> Value {
    json!({
        "behavior": {
            "selectionLookup": false,
            "selectionMaxLength": 500,
            "startOnBoot": false
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

#[cfg(target_os = "windows")]
fn apply_start_on_boot(enabled: bool) -> Result<(), String> {
    let app_data = std::env::var_os("APPDATA")
        .ok_or_else(|| "无法定位当前用户的 Windows 启动文件夹".to_string())?;
    let startup_file = PathBuf::from(app_data)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Startup")
        .join("Medict.cmd");

    if !enabled {
        match fs::remove_file(&startup_file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("移除 Windows 开机启动项失败：{error}")),
        }
        return Ok(());
    }

    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let parent = startup_file
        .parent()
        .ok_or_else(|| "无法定位当前用户的 Windows 启动文件夹".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建 Windows 开机启动文件失败：{error}"))?;

    // The Startup folder is per-user and does not require registry-editing
    // privileges. A small cmd launcher also works for unpacked and installed
    // builds without adding another runtime dependency.
    let executable = executable.to_string_lossy().replace('%', "%%");
    let contents = format!("@echo off\r\nstart \"\" \"{executable}\"\r\n");
    fs::write(&startup_file, contents)
        .map_err(|error| format!("更新 Windows 开机启动项失败：{error}"))
}

#[cfg(not(target_os = "windows"))]
fn apply_start_on_boot(_enabled: bool) -> Result<(), String> {
    Ok(())
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
fn settings_save(
    app: AppHandle,
    state: State<'_, AppState>,
    value: Value,
) -> Result<Value, String> {
    let start_on_boot = value
        .get("behavior")
        .and_then(|behavior| behavior.get("startOnBoot"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let previous_start_on_boot = state
        .settings
        .lock()
        .map_err(|_| "设置状态锁定失败".to_string())?
        .get("behavior")
        .and_then(|behavior| behavior.get("startOnBoot"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    write_settings(&state.settings_path, &value)?;
    {
        let mut settings = state
            .settings
            .lock()
            .map_err(|_| "设置状态锁定失败".to_string())?;
        *settings = value.clone();
    }

    if previous_start_on_boot != start_on_boot {
        apply_start_on_boot(start_on_boot)?;
    }
    if let Err(error) = restart_hotkey_manager(&app) {
        eprintln!("Medict show-window shortcut could not be registered: {error}");
    }
    if let Err(error) = restart_selection_monitor(&app) {
        eprintln!("Medict selection helper could not be restarted: {error}");
    }
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
            let translation = settings.get("translation");
            let source_language = translation
                .and_then(|value| value.get("source"))
                .and_then(Value::as_str)
                .unwrap_or("auto")
                .to_string();
            let target_language = translation
                .and_then(|value| value.get("target"))
                .and_then(Value::as_str)
                .unwrap_or("zh-CN")
                .to_string();
            word_lookup::LookupConfig {
                youdao_enabled,
                free_dictionary_enabled,
                service_order,
                source_language,
                target_language,
                ..Default::default()
            }
        })
        .map_err(|_| "读取词典服务设置失败".to_string())
}

#[cfg(target_os = "windows")]
fn parse_windows_hotkey(value: &str) -> Option<(u32, u32)> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
    };

    let mut modifiers = MOD_NOREPEAT;
    let mut key = None;
    for part in value
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "commandorcontrol" | "cmdorctrl" => modifiers |= MOD_CONTROL,
            "alt" | "option" => modifiers |= MOD_ALT,
            "shift" => modifiers |= MOD_SHIFT,
            "win" | "windows" | "meta" | "command" => modifiers |= MOD_WIN,
            token => {
                if key.is_some() {
                    return None;
                }
                key = Some(match token {
                    "space" => 0x20,
                    "tab" => 0x09,
                    "enter" | "return" => 0x0d,
                    "escape" | "esc" => 0x1b,
                    "backspace" => 0x08,
                    "up" | "arrowup" => 0x26,
                    "down" | "arrowdown" => 0x28,
                    "left" | "arrowleft" => 0x25,
                    "right" | "arrowright" => 0x27,
                    token if token.len() == 1 && token.as_bytes()[0].is_ascii_alphanumeric() => {
                        token.as_bytes()[0].to_ascii_uppercase() as u32
                    }
                    token if token.starts_with('f') => {
                        let number = token[1..].parse::<u32>().ok()?;
                        (1..=24).contains(&number).then_some(0x70 + number - 1)?
                    }
                    _ => return None,
                });
            }
        }
    }
    Some((modifiers, key?))
}

#[cfg(target_os = "windows")]
fn stop_hotkey_manager(app: &AppHandle) {
    let runtime = {
        let state = app.state::<AppState>();
        state
            .hotkey_runtime
            .lock()
            .ok()
            .and_then(|mut runtime| runtime.take())
    };
    if let Some(runtime) = runtime {
        runtime
            .stop
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = runtime.thread.join();
    }
}

#[cfg(not(target_os = "windows"))]
fn stop_hotkey_manager(_app: &AppHandle) {}

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _lifecycle = state
        .window_lifecycle
        .lock()
        .map_err(|_| "窗口状态锁定失败".to_string())?;

    let (window, created) = if let Some(window) = app.get_webview_window("main") {
        (window, false)
    } else {
        let config = app
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .cloned()
            .ok_or_else(|| "找不到主窗口配置".to_string())?;
        let window = WebviewWindowBuilder::from_config(app, &config)
            .map_err(|error| format!("重新创建主窗口失败：{error}"))?
            .build()
            .map_err(|error| format!("重新创建主窗口失败：{error}"))?;
        (window, true)
    };

    if created {
        // The selection helper receives the Medict HWND so it can avoid
        // capturing text from our own input box. Refresh it after recreating
        // the WebView/native window.
        let _ = restart_selection_monitor(app);
    }
    window
        .show()
        .map_err(|error| format!("显示主窗口失败：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("聚焦主窗口失败：{error}"))?;
    let _ = app.emit("window:show", json!({}));
    Ok(())
}

#[cfg(target_os = "windows")]
fn start_hotkey_manager(app: &AppHandle) -> Result<(), String> {
    use std::sync::mpsc;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};
    use windows_sys::Win32::UI::WindowsAndMessaging::{PeekMessageW, MSG, PM_REMOVE, WM_HOTKEY};

    stop_hotkey_manager(app);
    let shortcut = app
        .state::<AppState>()
        .settings
        .lock()
        .map_err(|_| "设置状态锁定失败".to_string())?
        .get("shortcuts")
        .and_then(|value| value.get("showWindow"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if shortcut.trim().is_empty() {
        return Ok(());
    }
    let (modifiers, key) = parse_windows_hotkey(&shortcut)
        .ok_or_else(|| format!("无法注册打开面板快捷键：{shortcut}"))?;
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let thread_stop = stop.clone();
    let thread_app = app.clone();
    let (ready_sender, ready_receiver) = mpsc::channel();
    let thread = std::thread::spawn(move || unsafe {
        let registered = RegisterHotKey(std::ptr::null_mut(), 1, modifiers, key) != 0;
        let _ = ready_sender.send(registered);
        if !registered {
            return;
        }
        let mut message: MSG = std::mem::zeroed();
        while !thread_stop.load(std::sync::atomic::Ordering::Relaxed) {
            while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                if message.message == WM_HOTKEY && message.wParam == 1 {
                    let _ = show_main_window(&thread_app);
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        UnregisterHotKey(std::ptr::null_mut(), 1);
    });

    match ready_receiver.recv_timeout(Duration::from_millis(800)) {
        Ok(true) => {
            let state = app.state::<AppState>();
            let mut runtime = state
                .hotkey_runtime
                .lock()
                .map_err(|_| "快捷键状态锁定失败".to_string())?;
            *runtime = Some(HotkeyRuntime { stop, thread });
            Ok(())
        }
        Ok(false) => {
            let _ = thread.join();
            Err(format!("打开面板快捷键 {shortcut} 已被其他程序占用"))
        }
        Err(_) => {
            let _ = thread.join();
            Err("打开面板快捷键注册超时".to_string())
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn start_hotkey_manager(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

fn restart_hotkey_manager(app: &AppHandle) -> Result<(), String> {
    stop_hotkey_manager(app);
    start_hotkey_manager(app)
}

fn selection_helper_path(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("SelectionHelper.exe"));
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            candidates.push(parent.join("SelectionHelper.exe"));
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("build")
            .join("SelectionHelper.exe"),
    );
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(target_os = "windows")]
fn native_window_handle(app: &AppHandle) -> String {
    app.get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|handle| (handle.0 as usize).to_string())
        .unwrap_or_else(|| "0".to_string())
}

#[cfg(not(target_os = "windows"))]
fn native_window_handle(_app: &AppHandle) -> String {
    "0".to_string()
}

fn emit_selection_status(app: &AppHandle, available: bool, active: bool, message: &str) {
    let _ = app.emit(
        "selection:status",
        json!({
            "available": available,
            "active": active,
            "message": message
        }),
    );
}

fn selection_settings(app: &AppHandle) -> Result<(bool, String, usize), String> {
    let state = app.state::<AppState>();
    state
        .settings
        .lock()
        .map(|settings| {
            let behavior = settings.get("behavior");
            let shortcuts = settings.get("shortcuts");
            let mouse_enabled = behavior
                .and_then(|value| value.get("selectionLookup"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let shortcut = shortcuts
                .and_then(|value| value.get("selectionLookup"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let max_length = behavior
                .and_then(|value| value.get("selectionMaxLength"))
                .and_then(Value::as_u64)
                .unwrap_or(500)
                .clamp(20, 4000) as usize;
            (mouse_enabled, shortcut, max_length)
        })
        .map_err(|_| "设置状态锁定失败".to_string())
}

fn stop_selection_monitor(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Ok(mut process) = state.selection_process.lock() {
        if let Some(mut child) = process.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    };
}

fn restart_selection_monitor(app: &AppHandle) -> Result<(), String> {
    stop_selection_monitor(app);
    start_selection_monitor(app)
}

fn start_selection_monitor(app: &AppHandle) -> Result<(), String> {
    let Some(helper) = selection_helper_path(app) else {
        emit_selection_status(app, false, false, "划词助手未编译");
        return Ok(());
    };
    let (mouse_enabled, shortcut, _) = selection_settings(app)?;
    if !mouse_enabled && shortcut.trim().is_empty() {
        emit_selection_status(app, true, false, "自动划词已关闭");
        return Ok(());
    }

    let mut command = Command::new(&helper);
    command
        .args([
            std::process::id().to_string(),
            native_window_handle(app),
            shortcut,
            if mouse_enabled {
                "1".to_string()
            } else {
                "0".to_string()
            },
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动划词助手失败：{error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "划词助手没有输出通道".to_string())?;
    let child_pid = child.id();
    {
        let state = app.state::<AppState>();
        let mut process = state
            .selection_process
            .lock()
            .map_err(|_| "划词助手状态锁定失败".to_string())?;
        *process = Some(child);
    }

    emit_selection_status(app, true, false, "正在启动自动划词");
    let reader_app = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            handle_selection_line(&reader_app, line.trim());
        }
        let state = reader_app.state::<AppState>();
        if let Ok(mut process) = state.selection_process.lock() {
            if process
                .as_ref()
                .map(|child| child.id() == child_pid)
                .unwrap_or(false)
            {
                *process = None;
            }
        }
        emit_selection_status(&reader_app, true, false, "划词助手已停止");
    });
    Ok(())
}

fn selection_empty_message(app: &AppHandle) -> String {
    let shortcut = selection_settings(app)
        .map(|(_, value, _)| value)
        .unwrap_or_default();
    let label = shortcut
        .replace("CommandOrControl", "Ctrl")
        .split('+')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" + ");
    if label.is_empty() {
        "未读取到选中文本，请重新选择后使用“选词后查词”快捷键".to_string()
    } else {
        format!("未读取到选中文本，请重新选择后按 {label}")
    }
}

fn handle_selection_line(app: &AppHandle, line: &str) {
    if line == "READY" {
        let active = selection_settings(app)
            .map(|(mouse_enabled, _, _)| mouse_enabled)
            .unwrap_or(false);
        emit_selection_status(
            app,
            true,
            active,
            if active {
                "自动划词已开启"
            } else {
                "自动划词已关闭，快捷键仍可用"
            },
        );
        return;
    }
    if line == "KEYBOARD_READY" {
        return;
    }
    if line == "EMPTY" {
        let _ = app.emit(
            "selection:empty",
            json!({ "message": selection_empty_message(app) }),
        );
        return;
    }
    if let Some(message) = line.strip_prefix("ERROR\t") {
        emit_selection_status(app, true, false, message.trim());
        return;
    }

    let encoded = line
        .strip_prefix("TEXT\t")
        .or_else(|| line.strip_prefix("SHORTCUT_TEXT\t"));
    let Some(encoded) = encoded else {
        return;
    };
    let Ok(bytes) = BASE64.decode(encoded.as_bytes()) else {
        return;
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return;
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        return;
    }
    spawn_selection_lookup(app.clone(), text);
}

fn spawn_selection_lookup(app: AppHandle, raw_text: String) {
    let Ok((_, _, max_length)) = selection_settings(&app) else {
        return;
    };
    let query = raw_text.trim().chars().take(max_length).collect::<String>();
    if query.is_empty() {
        return;
    }
    // A hidden panel releases its WebView2 instance. Recreate it before
    // publishing selection events so the newly loaded renderer can receive
    // the pending/result events.
    let _ = show_main_window(&app);
    let state = app.state::<AppState>();
    let request_id = state.selection_request_id.fetch_add(1, Ordering::Relaxed) + 1;
    let _ = app.emit(
        "selection:pending",
        json!({ "query": query, "requestId": request_id }),
    );

    tauri::async_runtime::spawn(async move {
        let result = {
            let state = app.state::<AppState>();
            match lookup_config(&state) {
                Ok(config) => word_lookup::lookup_word(&query, config).await,
                Err(error) => Err(error),
            }
        };
        let (word, error) = match result {
            Ok(value) => (Some(value), String::new()),
            Err(error) => (None, error),
        };
        let _ = app.emit(
            "selection:result",
            json!({
                "query": query,
                "requestId": request_id,
                "partial": false,
                "word": word,
                "errors": { "word": error }
            }),
        );
    });
}

#[tauri::command]
async fn lookup_word(
    state: State<'_, AppState>,
    query: String,
    options: Value,
) -> Result<Value, String> {
    let mut config = lookup_config(&state)?;
    if let Some(source) = options
        .get("source")
        .or_else(|| options.get("sourceLanguage"))
        .and_then(Value::as_str)
    {
        config.source_language = source.to_string();
    }
    if let Some(target) = options
        .get("target")
        .or_else(|| options.get("targetLanguage"))
        .and_then(Value::as_str)
    {
        config.target_language = target.to_string();
    }
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
fn selection_status(app: AppHandle, state: State<'_, AppState>) -> Value {
    let available = selection_helper_path(&app).is_some();
    let running = state
        .selection_process
        .lock()
        .ok()
        .and_then(|mut process| {
            process.as_mut().map(|child| match child.try_wait() {
                Ok(None) => true,
                Ok(Some(_)) | Err(_) => false,
            })
        })
        .unwrap_or(false);
    let active = running
        && state
            .settings
            .lock()
            .ok()
            .and_then(|settings| {
                settings
                    .get("behavior")
                    .and_then(|behavior| behavior.get("selectionLookup"))
                    .and_then(Value::as_bool)
            })
            .unwrap_or(false);
    json!({
        "available": available,
        "active": active,
        "message": if !available {
            "划词助手未编译"
        } else if active {
            "自动划词已开启"
        } else if running {
            "自动划词已关闭，快捷键仍可用"
        } else {
            "自动划词已关闭"
        }
    })
}

#[tauri::command]
fn shortcuts_suspend(app: AppHandle) -> bool {
    stop_hotkey_manager(&app);
    stop_selection_monitor(&app);
    true
}

#[tauri::command]
fn shortcuts_resume(app: AppHandle) -> bool {
    let hotkey_ok = restart_hotkey_manager(&app).is_ok();
    let selection_ok = restart_selection_monitor(&app).is_ok();
    hotkey_ok && selection_ok
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
fn window_hide(app: AppHandle, window: Window) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _lifecycle = state
        .window_lifecycle
        .lock()
        .map_err(|_| "窗口状态锁定失败".to_string())?;
    state
        .keep_alive_after_window_destroy
        .store(true, Ordering::Relaxed);
    let result = window.destroy().map_err(|error| error.to_string());
    if result.is_ok() {
        let _ = restart_selection_monitor(&app);
    }
    result
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
    stop_hotkey_manager(&app);
    stop_selection_monitor(&app);
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

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "显示 Medict", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 Medict", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("默认应用图标".to_string()))?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("Medict")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Err(error) = show_main_window(app) {
                    eprintln!("Medict could not be shown from the tray: {error}");
                }
            }
            "quit" => {
                stop_hotkey_manager(app);
                stop_selection_monitor(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Err(error) = show_main_window(tray.app_handle()) {
                    eprintln!("Medict could not be shown from the tray icon: {error}");
                }
            }
        })
        .build(app)?;

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                if let Some(state) = app.try_state::<AppState>() {
                    state
                        .keep_alive_after_window_destroy
                        .store(true, Ordering::Relaxed);
                }
                let _ = window.destroy();
            }
        })
        .setup(|app| {
            setup_tray(app)?;
            let path = settings_path(app.handle())?;
            let settings = load_settings(&path);
            if settings
                .get("behavior")
                .and_then(|behavior| behavior.get("startOnBoot"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                if let Err(error) = apply_start_on_boot(true) {
                    eprintln!("Medict startup setting could not be restored: {error}");
                }
            }
            app.manage(AppState {
                settings: Mutex::new(settings),
                settings_path: path,
                window_lifecycle: Mutex::new(()),
                keep_alive_after_window_destroy: AtomicBool::new(false),
                selection_process: Mutex::new(None),
                selection_request_id: AtomicU64::new(0),
                hotkey_runtime: Mutex::new(None),
            });
            if let Err(error) = restart_hotkey_manager(app.handle()) {
                eprintln!("Medict show-window shortcut could not be started: {error}");
            }
            if let Err(error) = restart_selection_monitor(app.handle()) {
                eprintln!("Medict selection helper could not be started: {error}");
            }
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
        .build(tauri::generate_context!())
        .expect("error while building Medict Tauri")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                // Destroying the last WebView is intentional: keep the Rust
                // process alive for hotkeys/selection and recreate the page
                // lazily on the next show request.
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if state
                        .keep_alive_after_window_destroy
                        .swap(false, Ordering::Relaxed)
                    {
                        api.prevent_exit();
                    }
                }
            }
        });
}

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod modern_d2d;

use std::{
    ffi::c_void,
    mem::size_of,
    slice,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::Duration,
};

use medict_core::{drug_lookup, word_lookup};
use modern_d2d::{DisplayLine, LineStyle, Renderer};
use serde_json::Value;
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{
            GlobalFree, HANDLE, HGLOBAL, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
        },
        Graphics::Gdi::{
            BeginPaint, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, GetStockObject,
            InvalidateRect, RoundRect, ScreenToClient, SelectObject, SetBkColor, SetBkMode,
            SetTextColor, UpdateWindow, DT_CENTER, DT_SINGLELINE, DT_VCENTER, HDC, HGDIOBJ,
            NULL_PEN, OPAQUE, PAINTSTRUCT, TRANSPARENT,
        },
        System::{
            Com::{CoInitializeEx, COINIT_APARTMENTTHREADED},
            DataExchange::{
                CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
            },
            LibraryLoader::GetModuleHandleW,
            Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
        },
        UI::{
            Controls::{SetScrollInfo, DRAWITEMSTRUCT, ODS_SELECTED},
            Input::KeyboardAndMouse::{
                RegisterHotKey, ReleaseCapture, SendInput, SetFocus, UnregisterHotKey, INPUT,
                INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, MOD_ALT, MOD_NOREPEAT,
                VIRTUAL_KEY, VK_CONTROL, VK_ESCAPE,
            },
            Shell::{
                DefSubclassProc, SetWindowSubclass, Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE,
                NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
            },
            WindowsAndMessaging::{
                AppendMenuW, BringWindowToTop, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
                DestroyMenu, DestroyWindow, DispatchMessageW, GetClientRect, GetCursorPos,
                GetMessageW, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, LoadCursorW,
                LoadIconW, MoveWindow, PostMessageW, PostQuitMessage, RegisterClassExW,
                SendMessageW, SetForegroundWindow, SetWindowLongPtrW, SetWindowTextW, ShowWindow,
                TrackPopupMenu, TranslateMessage, BS_OWNERDRAW, CREATESTRUCTW, CS_HREDRAW,
                CS_VREDRAW, CW_USEDEFAULT, EN_CHANGE, ES_AUTOHSCROLL, ES_AUTOVSCROLL, ES_MULTILINE,
                GWLP_USERDATA, HTCAPTION, IDC_ARROW, IDI_APPLICATION, MF_STRING, SBS_VERT,
                SB_BOTTOM, SB_CTL, SB_LINEDOWN, SB_LINEUP, SB_PAGEDOWN, SB_PAGEUP,
                SB_THUMBPOSITION, SB_THUMBTRACK, SB_TOP, SCROLLINFO, SIF_PAGE, SIF_POS, SIF_RANGE,
                SW_HIDE, SW_MINIMIZE, SW_RESTORE, SW_SHOW, TPM_NONOTIFY, TPM_RETURNCMD,
                WINDOW_STYLE, WM_APP, WM_CLOSE, WM_COMMAND, WM_CREATE, WM_CTLCOLOREDIT, WM_DESTROY,
                WM_DRAWITEM, WM_ERASEBKGND, WM_HOTKEY, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP,
                WM_MOUSEWHEEL, WM_NCCREATE, WM_NCLBUTTONDOWN, WM_PAINT, WM_SIZE, WM_VSCROLL,
                WNDCLASSEXW, WS_CHILD, WS_EX_APPWINDOW, WS_POPUP, WS_TABSTOP, WS_THICKFRAME,
                WS_VISIBLE,
            },
        },
    },
};

const WINDOW_CLASS: PCWSTR = w!("MedictNativeWindow");
const EDIT_ID: usize = 1001;
const QUERY_ID: usize = 1002;
const DRUG_ID: usize = 1003;
const SCROLLBAR_ID: usize = 1004;
const MENU_SHOW: usize = 2001;
const MENU_EXIT: usize = 2002;
const HOTKEY_SHOW: i32 = 1;
const HOTKEY_SELECTION: i32 = 2;
const TRAY_ID: u32 = 1;
const WM_APP_QUERY_RESULT: u32 = WM_APP + 1;
const WM_APP_TRAY: u32 = WM_APP + 2;
const CF_UNICODETEXT: u32 = 13;
const APP_ICON_RESOURCE: PCWSTR = PCWSTR(1 as *const u16);
const TITLEBAR_HEIGHT: i32 = 34;
static EDIT_BACKGROUND_BRUSH: OnceLock<isize> = OnceLock::new();

#[derive(Clone, Copy, PartialEq, Eq)]
enum QueryKind {
    Word,
    Drug,
}

struct SharedUiState {
    lines: Vec<DisplayLine>,
    loading: bool,
    query: String,
    active_kind: QueryKind,
    source_language: String,
    target_language: String,
    selection_status: String,
    request_status: String,
    history: Vec<String>,
    history_open: bool,
}

struct AppContext {
    hwnd: HWND,
    input: HWND,
    query_button: HWND,
    drug_button: HWND,
    scrollbar: HWND,
    renderer: Renderer,
    shared: Arc<Mutex<SharedUiState>>,
    request_id: Arc<AtomicU64>,
    scroll_y: i32,
    content_height: i32,
}

impl AppContext {
    fn new() -> windows::core::Result<Self> {
        Ok(Self {
            hwnd: HWND::default(),
            input: HWND::default(),
            query_button: HWND::default(),
            drug_button: HWND::default(),
            scrollbar: HWND::default(),
            renderer: Renderer::new()?,
            shared: Arc::new(Mutex::new(SharedUiState {
                lines: vec![
                    line("一个输入框，两种查询", LineStyle::Section, 0.0),
                    line(
                        "英文单词显示完整在线词典，短语和句子自动翻译。",
                        LineStyle::Body,
                        0.0,
                    ),
                    line("药物数据仅在点击“药物查询”后请求。", LineStyle::Muted, 0.0),
                ],
                loading: false,
                query: String::new(),
                active_kind: QueryKind::Word,
                source_language: "自动识别".to_string(),
                target_language: "简体中文".to_string(),
                selection_status: "自动划词已开启".to_string(),
                request_status: "在线词典待命".to_string(),
                history: Vec::new(),
                history_open: false,
            })),
            request_id: Arc::new(AtomicU64::new(0)),
            scroll_y: 0,
            content_height: 0,
        })
    }

    fn active_kind(&self) -> QueryKind {
        self.shared
            .lock()
            .map(|state| state.active_kind)
            .unwrap_or(QueryKind::Word)
    }
}

fn line(text: impl Into<String>, style: LineStyle, indent: f32) -> DisplayLine {
    DisplayLine {
        text: text.into(),
        style,
        indent,
    }
}

unsafe fn draw_action_button(item: &DRAWITEMSTRUCT, active_kind: QueryKind) {
    let is_query = item.CtlID as usize == QUERY_ID;
    let is_active = (is_query && active_kind == QueryKind::Word)
        || (!is_query && active_kind == QueryKind::Drug);
    let selected = item.itemState.0 & ODS_SELECTED.0 != 0;
    let fill = if is_active {
        if selected {
            windows::Win32::Foundation::COLORREF(0x00c45731)
        } else {
            windows::Win32::Foundation::COLORREF(0x00e8724c)
        }
    } else if selected {
        windows::Win32::Foundation::COLORREF(0x00d4d4d1)
    } else {
        windows::Win32::Foundation::COLORREF(0x00dededb)
    };
    let text_color = if is_active {
        windows::Win32::Foundation::COLORREF(0x00ffffff)
    } else {
        windows::Win32::Foundation::COLORREF(0x00514d4a)
    };
    let brush = CreateSolidBrush(fill);
    if brush.is_invalid() {
        return;
    }
    let old_brush = SelectObject(item.hDC, HGDIOBJ::from(brush));
    let old_pen = SelectObject(item.hDC, GetStockObject(NULL_PEN));
    let rect = item.rcItem;
    let _ = RoundRect(
        item.hDC,
        rect.left + 1,
        rect.top + 1,
        rect.right - 1,
        rect.bottom - 1,
        18,
        18,
    );
    let _ = SelectObject(item.hDC, old_pen);
    let _ = SelectObject(item.hDC, old_brush);
    let _ = DeleteObject(HGDIOBJ::from(brush));

    let _ = SetBkMode(item.hDC, TRANSPARENT);
    let _ = SetTextColor(item.hDC, text_color);
    let mut text = if is_query { "查词" } else { "药物查询" }
        .encode_utf16()
        .collect::<Vec<u16>>();
    let mut text_rect = RECT {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    };
    let _ = DrawTextW(
        item.hDC,
        &mut text,
        &mut text_rect,
        DT_CENTER | DT_VCENTER | DT_SINGLELINE,
    );
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Medict Native 启动失败：{error}");
    }
}

fn run() -> windows::core::Result<()> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let instance = GetModuleHandleW(None)?;
        let instance = HINSTANCE(instance.0);
        register_window_class(instance)?;

        let context = Box::new(AppContext::new()?);
        let context_ptr = Box::into_raw(context);
        let hwnd = match CreateWindowExW(
            WS_EX_APPWINDOW,
            WINDOW_CLASS,
            w!("Medict"),
            WS_POPUP | WS_THICKFRAME,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            440,
            680,
            None,
            None,
            Some(instance),
            Some(context_ptr.cast()),
        ) {
            Ok(hwnd) => hwnd,
            Err(error) => {
                drop(Box::from_raw(context_ptr));
                return Err(error);
            }
        };

        let context = &mut *context_ptr;
        context.hwnd = hwnd;
        let _ = SetWindowLongPtrW(hwnd, GWLP_USERDATA, context_ptr as isize);
        create_children(context);
        layout_children(context);
        sync_scrollbar(context);
        let _ = RegisterHotKey(Some(hwnd), HOTKEY_SHOW, MOD_ALT | MOD_NOREPEAT, b'M' as u32);
        let _ = RegisterHotKey(
            Some(hwnd),
            HOTKEY_SELECTION,
            MOD_ALT | MOD_NOREPEAT,
            b'D' as u32,
        );
        add_tray_icon(hwnd);
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = UpdateWindow(hwnd);
        let _ = SetFocus(Some(context.input));

        let mut message = windows::Win32::UI::WindowsAndMessaging::MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            let _ = DispatchMessageW(&message);
        }
    }
    Ok(())
}

unsafe fn register_window_class(instance: HINSTANCE) -> windows::core::Result<()> {
    let class = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as u32,
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(window_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: LoadIconW(Some(instance), APP_ICON_RESOURCE)
            .or_else(|_| LoadIconW(None, IDI_APPLICATION))
            .unwrap_or_default(),
        hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
        hbrBackground: Default::default(),
        lpszMenuName: PCWSTR::null(),
        lpszClassName: WINDOW_CLASS,
        hIconSm: LoadIconW(Some(instance), APP_ICON_RESOURCE)
            .or_else(|_| LoadIconW(None, IDI_APPLICATION))
            .unwrap_or_default(),
    };
    let _ = RegisterClassExW(&class);
    Ok(())
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    if message == WM_NCCREATE {
        let create = &*(lparam.0 as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
    }

    let context_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut AppContext;
    if context_ptr.is_null() {
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
    let context = &mut *context_ptr;

    match message {
        WM_CREATE => LRESULT(0),
        WM_SIZE => {
            layout_children(context);
            let width = (lparam.0 as u32 & 0xffff) as u32;
            let height = ((lparam.0 as u32 >> 16) & 0xffff) as u32;
            context.renderer.resize(width, height);
            sync_scrollbar(context);
            LRESULT(0)
        }
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            BeginPaint(hwnd, &mut paint);
            let mut rect = RECT::default();
            let _ = GetClientRect(hwnd, &mut rect);
            let (
                lines,
                query,
                header,
                loading,
                source_language,
                target_language,
                selection_status,
                request_status,
                history,
                history_open,
            ) = context
                .shared
                .lock()
                .map(|state| {
                    (
                        state.lines.clone(),
                        state.query.clone(),
                        if state.active_kind == QueryKind::Drug {
                            "DRUG".to_string()
                        } else {
                            "WORD".to_string()
                        },
                        state.loading,
                        state.source_language.clone(),
                        state.target_language.clone(),
                        state.selection_status.clone(),
                        state.request_status.clone(),
                        state.history.clone(),
                        state.history_open,
                    )
                })
                .unwrap_or_default();
            context.renderer.paint(
                hwnd,
                (rect.right - rect.left).max(0) as u32,
                (rect.bottom - rect.top).max(0) as u32,
                context.scroll_y,
                &query,
                &header,
                loading,
                &source_language,
                &target_language,
                &selection_status,
                &request_status,
                &history,
                history_open,
                &lines,
            );
            let _ = EndPaint(hwnd, &paint);
            LRESULT(0)
        }
        WM_CTLCOLOREDIT => {
            let hdc = HDC(wparam.0 as *mut c_void);
            let background = windows::Win32::Foundation::COLORREF(0x00ebeded);
            let _ = SetBkMode(hdc, OPAQUE);
            let _ = SetBkColor(hdc, background);
            let _ = SetTextColor(hdc, windows::Win32::Foundation::COLORREF(0x002a2c31));
            let brush =
                EDIT_BACKGROUND_BRUSH.get_or_init(|| CreateSolidBrush(background).0 as isize);
            LRESULT(*brush)
        }
        WM_DRAWITEM => {
            let draw_item = &*(lparam.0 as *const DRAWITEMSTRUCT);
            draw_action_button(draw_item, context.active_kind());
            LRESULT(1)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_COMMAND => {
            let id = wparam.0 & 0xffff;
            let notification = (wparam.0 >> 16) & 0xffff;
            if id == EDIT_ID && notification == EN_CHANGE as usize {
                // The edit is intentionally painted with an opaque card-colored
                // brush. Force a redraw on every edit change so deleted glyphs do
                // not remain as stale pixels behind the caret.
                let _ = InvalidateRect(Some(context.input), None, true);
                let _ = UpdateWindow(context.input);
            } else if id == QUERY_ID {
                let query = read_window_text(context.input);
                start_query(context, QueryKind::Word, query);
            } else if id == DRUG_ID {
                let query = read_window_text(context.input);
                start_query(context, QueryKind::Drug, query);
            }
            LRESULT(0)
        }
        WM_VSCROLL => {
            handle_scroll(
                context,
                (wparam.0 & 0xffff) as i32,
                ((wparam.0 >> 16) & 0xffff) as i16,
            );
            LRESULT(0)
        }
        WM_MOUSEWHEEL => {
            let mut point = POINT {
                x: (lparam.0 as u32 & 0xffff) as i16 as i32,
                y: ((lparam.0 as u32 >> 16) & 0xffff) as i16 as i32,
            };
            let _ = ScreenToClient(context.hwnd, &mut point);
            if point.y < modern_d2d::RESULT_TOP {
                return LRESULT(0);
            }
            let delta = ((wparam.0 >> 16) & 0xffff) as i16;
            context.scroll_y = (context.scroll_y - i32::from(delta) / 2).max(0);
            sync_scrollbar(context);
            let _ = InvalidateRect(Some(hwnd), None, false);
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            let x = (lparam.0 as u32 & 0xffff) as i16 as i32;
            let y = ((lparam.0 as u32 >> 16) & 0xffff) as i16 as i32;
            let mut client = RECT::default();
            let _ = GetClientRect(context.hwnd, &mut client);
            if (0..TITLEBAR_HEIGHT).contains(&y) && x < client.right - 96 && x >= 0 {
                let _ = ReleaseCapture();
                let _ = SendMessageW(
                    context.hwnd,
                    WM_NCLBUTTONDOWN,
                    Some(WPARAM(HTCAPTION as usize)),
                    Some(LPARAM(0)),
                );
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let x = (lparam.0 as u32 & 0xffff) as i16 as i32;
            let y = ((lparam.0 as u32 >> 16) & 0xffff) as i16 as i32;
            let mut client = RECT::default();
            let _ = GetClientRect(context.hwnd, &mut client);
            if (0..TITLEBAR_HEIGHT).contains(&y) {
                if x >= client.right - 36 {
                    let _ = ShowWindow(context.hwnd, SW_HIDE);
                } else if x >= client.right - 64 {
                    let _ = ShowWindow(context.hwnd, SW_MINIMIZE);
                }
                return LRESULT(0);
            }

            let history_top = modern_d2d::RESULT_TOP + 12;
            let history_left = client.right - 320;
            let selected_history_query =
                if x >= history_left && x <= client.right - 15 && y >= history_top + 31 {
                    let index = ((y - history_top - 31) / 30) as usize;
                    context.shared.lock().ok().and_then(|state| {
                        if state.history_open {
                            state.history.get(index).cloned()
                        } else {
                            None
                        }
                    })
                } else {
                    None
                };
            if let Some(query) = selected_history_query {
                if let Ok(mut state) = context.shared.lock() {
                    state.history_open = false;
                }
                set_window_text(context.input, &query);
                let _ = SetFocus(Some(context.input));
                start_query(context, QueryKind::Word, query);
                return LRESULT(0);
            }
            if let Ok(mut state) = context.shared.lock() {
                if state.history_open
                    && !(x >= history_left
                        && x <= client.right - 15
                        && y >= history_top
                        && y <= history_top + 360)
                {
                    state.history_open = false;
                    let _ = InvalidateRect(Some(context.hwnd), None, false);
                }
            }

            if (TITLEBAR_HEIGHT + 104..=TITLEBAR_HEIGHT + 138).contains(&y)
                && ((client.right / 2 - 24)..=(client.right / 2 + 24)).contains(&x)
            {
                swap_languages(context);
            }

            if (TITLEBAR_HEIGHT + 70..=TITLEBAR_HEIGHT + 96).contains(&y) {
                if (client.right - 92..=client.right - 64).contains(&x) {
                    let query = read_window_text(context.input);
                    let copied = write_clipboard_text(&query);
                    if let Ok(mut state) = context.shared.lock() {
                        state.request_status = if copied {
                            "输入已复制".to_string()
                        } else {
                            "复制失败".to_string()
                        };
                    }
                    let _ = InvalidateRect(Some(context.hwnd), None, false);
                } else if (client.right - 64..=client.right - 37).contains(&x) {
                    if let Ok(mut state) = context.shared.lock() {
                        state.history_open = !state.history_open;
                    }
                    let _ = InvalidateRect(Some(context.hwnd), None, false);
                } else if x >= client.right - 37 {
                    let _ = SetWindowTextW(context.input, w!(""));
                    let _ = SetFocus(Some(context.input));
                    if let Ok(mut state) = context.shared.lock() {
                        state.query.clear();
                        state.history_open = false;
                        state.lines = vec![
                            line("一个输入框，两种查询", LineStyle::Section, 0.0),
                            line(
                                "英文单词显示完整在线词典，短语和句子自动翻译。",
                                LineStyle::Body,
                                0.0,
                            ),
                            line("药物数据仅在点击“药物查询”后请求。", LineStyle::Muted, 0.0),
                        ];
                        state.request_status = "在线词典待命".to_string();
                    }
                    context.scroll_y = 0;
                    sync_scrollbar(context);
                    let _ = InvalidateRect(Some(context.hwnd), None, false);
                }
                return LRESULT(0);
            }

            LRESULT(0)
        }
        WM_HOTKEY => {
            match wparam.0 as i32 {
                HOTKEY_SHOW => show_panel(context),
                HOTKEY_SELECTION => start_selection_lookup(context),
                _ => {}
            }
            LRESULT(0)
        }
        WM_APP_QUERY_RESULT => {
            sync_scrollbar(context);
            let _ = InvalidateRect(Some(hwnd), None, false);
            LRESULT(0)
        }
        WM_APP_TRAY => handle_tray_message(context, lparam.0 as u32),
        WM_CLOSE => {
            let _ = ShowWindow(hwnd, SW_HIDE);
            LRESULT(0)
        }
        WM_DESTROY => {
            remove_tray_icon(hwnd);
            let _ = UnregisterHotKey(Some(hwnd), HOTKEY_SHOW);
            let _ = UnregisterHotKey(Some(hwnd), HOTKEY_SELECTION);
            PostQuitMessage(0);
            drop(Box::from_raw(context_ptr));
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

unsafe extern "system" fn edit_subclass_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    ref_data: usize,
) -> windows::Win32::Foundation::LRESULT {
    if message == WM_KEYDOWN && wparam.0 as u16 == VK_ESCAPE.0 {
        let context = &mut *(ref_data as *mut AppContext);
        let _ = ShowWindow(context.hwnd, SW_HIDE);
        return LRESULT(0);
    }
    if message == WM_KEYDOWN && wparam.0 as u16 == 0x0d {
        let context = &mut *(ref_data as *mut AppContext);
        let query = read_window_text(context.input);
        start_query(context, QueryKind::Word, query);
        return LRESULT(0);
    }
    let result = DefSubclassProc(hwnd, message, wparam, lparam);
    if message == WM_KEYDOWN && matches!(wparam.0 as u16, 0x08 | 0x2e) {
        let _ = InvalidateRect(Some(hwnd), None, true);
        let _ = UpdateWindow(hwnd);
    }
    result
}

unsafe fn create_children(context: &mut AppContext) {
    let edit_style = WS_CHILD
        | WS_VISIBLE
        | WS_TABSTOP
        | WINDOW_STYLE((ES_AUTOHSCROLL | ES_AUTOVSCROLL | ES_MULTILINE) as u32);
    let button_style = WS_CHILD | WS_VISIBLE | WS_TABSTOP | WINDOW_STYLE(BS_OWNERDRAW as u32);
    let hinstance = HINSTANCE(
        GetModuleHandleW(None)
            .map(|value| value.0)
            .unwrap_or_default(),
    );
    context.input = CreateWindowExW(
        Default::default(),
        w!("EDIT"),
        w!(""),
        edit_style,
        20,
        TITLEBAR_HEIGHT + 15,
        480,
        70,
        Some(context.hwnd),
        Some(windows::Win32::UI::WindowsAndMessaging::HMENU(
            EDIT_ID as *mut c_void,
        )),
        Some(hinstance),
        None,
    )
    .unwrap_or_default();
    context.query_button = CreateWindowExW(
        Default::default(),
        w!("BUTTON"),
        w!("查询"),
        button_style,
        8,
        TITLEBAR_HEIGHT + 146,
        238,
        38,
        Some(context.hwnd),
        Some(windows::Win32::UI::WindowsAndMessaging::HMENU(
            QUERY_ID as *mut c_void,
        )),
        Some(hinstance),
        None,
    )
    .unwrap_or_default();
    context.drug_button = CreateWindowExW(
        Default::default(),
        w!("BUTTON"),
        w!("药物查询"),
        button_style,
        254,
        TITLEBAR_HEIGHT + 146,
        238,
        38,
        Some(context.hwnd),
        Some(windows::Win32::UI::WindowsAndMessaging::HMENU(
            DRUG_ID as *mut c_void,
        )),
        Some(hinstance),
        None,
    )
    .unwrap_or_default();
    context.scrollbar = CreateWindowExW(
        Default::default(),
        w!("SCROLLBAR"),
        w!(""),
        WS_CHILD | WINDOW_STYLE(SBS_VERT as u32),
        0,
        modern_d2d::RESULT_TOP,
        14,
        100,
        Some(context.hwnd),
        Some(windows::Win32::UI::WindowsAndMessaging::HMENU(
            SCROLLBAR_ID as *mut c_void,
        )),
        Some(hinstance),
        None,
    )
    .unwrap_or_default();

    let _ = SetWindowTextW(context.input, w!(""));
    let _ = SetWindowSubclass(
        context.input,
        Some(edit_subclass_proc),
        1,
        context as *mut AppContext as usize,
    );
}

unsafe fn layout_children(context: &AppContext) {
    let mut rect = RECT::default();
    let _ = GetClientRect(context.hwnd, &mut rect);
    let width = (rect.right - rect.left).max(260);
    let button_width = ((width - 23) / 2).max(100);
    let _ = MoveWindow(
        context.input,
        18,
        TITLEBAR_HEIGHT + 15,
        (width - 118).max(180),
        72,
        true,
    );
    let _ = MoveWindow(
        context.query_button,
        8,
        TITLEBAR_HEIGHT + 146,
        button_width,
        38,
        true,
    );
    let _ = MoveWindow(
        context.drug_button,
        15 + button_width,
        TITLEBAR_HEIGHT + 146,
        button_width,
        38,
        true,
    );
    let result_top = modern_d2d::RESULT_TOP;
    let result_height = (rect.bottom - result_top - 2).max(0);
    let _ = MoveWindow(
        context.scrollbar,
        (width - 17).max(0),
        result_top + 1,
        13,
        result_height,
        true,
    );
}

unsafe fn read_window_text(hwnd: HWND) -> String {
    let length = GetWindowTextLengthW(hwnd).max(0) as usize;
    let mut buffer = vec![0u16; length + 1];
    let count = GetWindowTextW(hwnd, &mut buffer).max(0) as usize;
    String::from_utf16_lossy(&buffer[..count])
        .trim()
        .to_string()
}

unsafe fn set_window_text(hwnd: HWND, text: &str) {
    let wide = text
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let _ = SetWindowTextW(hwnd, PCWSTR(wide.as_ptr()));
}

unsafe fn show_panel(context: &AppContext) {
    let _ = ShowWindow(context.hwnd, SW_SHOW);
    let _ = ShowWindow(context.hwnd, SW_RESTORE);
    let _ = BringWindowToTop(context.hwnd);
    let _ = SetForegroundWindow(context.hwnd);
    let _ = SetFocus(Some(context.input));
}

unsafe fn swap_languages(context: &mut AppContext) {
    if let Ok(mut state) = context.shared.lock() {
        let source = state.source_language.clone();
        state.source_language = state.target_language.clone();
        state.target_language = source;
    }
    let _ = InvalidateRect(Some(context.hwnd), None, false);
}

unsafe fn start_query(context: &mut AppContext, kind: QueryKind, query: String) {
    let query = query.trim().to_string();
    let request = context.request_id.fetch_add(1, Ordering::Relaxed) + 1;
    {
        if let Ok(mut state) = context.shared.lock() {
            state.query = query.clone();
            state.loading = true;
            state.active_kind = kind;
            state.history_open = false;
            if !query.is_empty() {
                state.history.retain(|item| item != &query);
                state.history.insert(0, query.clone());
                state.history.truncate(10);
            }
            state.request_status = if query.is_empty() {
                "等待输入".to_string()
            } else {
                "正在查询…".to_string()
            };
            state.lines = vec![line(
                if query.is_empty() {
                    "请输入单词、中文或句子"
                } else {
                    "正在请求在线数据…"
                },
                LineStyle::Muted,
                0.0,
            )];
        }
    }
    context.scroll_y = 0;
    sync_scrollbar(context);
    let _ = InvalidateRect(Some(context.hwnd), None, false);
    if query.is_empty() {
        finish_error(
            context.shared.clone(),
            context.request_id.clone(),
            request,
            context.hwnd.0 as isize,
            "请输入查询内容",
        );
        return;
    }

    let shared = context.shared.clone();
    let request_id = context.request_id.clone();
    let hwnd_value = context.hwnd.0 as isize;
    thread::spawn(move || {
        perform_lookup(kind, query, request, shared, request_id, hwnd_value);
    });
}

fn perform_lookup(
    kind: QueryKind,
    query: String,
    request: u64,
    shared: Arc<Mutex<SharedUiState>>,
    request_id: Arc<AtomicU64>,
    hwnd_value: isize,
) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();
    let output = match runtime {
        Ok(runtime) => match kind {
            QueryKind::Word => runtime.block_on(word_lookup::lookup_word(
                &query,
                word_lookup::LookupConfig {
                    youdao_enabled: true,
                    free_dictionary_enabled: true,
                    service_order: vec!["youdaoDictionary".into(), "freeDictionary".into()],
                    source_language: "auto".into(),
                    target_language: "zh-CN".into(),
                    ..Default::default()
                },
            )),
            QueryKind::Drug => runtime.block_on(drug_lookup::lookup_drug(&query)),
        },
        Err(error) => Err(format!("创建网络运行时失败：{error}")),
    };

    if request_id.load(Ordering::Relaxed) != request {
        return;
    }
    let (lines, request_status) = match output {
        Ok(value) if matches!(kind, QueryKind::Drug) => {
            (drug_lines(&value), "药物数据已返回".to_string())
        }
        Ok(value) => (word_lines(&query, &value), "在线词典已返回".to_string()),
        Err(error) => (
            vec![line(error, LineStyle::Error, 0.0)],
            "请求失败".to_string(),
        ),
    };
    if let Ok(mut state) = shared.lock() {
        state.lines = lines;
        state.loading = false;
        state.request_status = request_status;
    }
    unsafe {
        let hwnd = HWND(hwnd_value as *mut c_void);
        let _ = PostMessageW(Some(hwnd), WM_APP_QUERY_RESULT, WPARAM(0), LPARAM(0));
    }
}

fn finish_error(
    shared: Arc<Mutex<SharedUiState>>,
    request_id: Arc<AtomicU64>,
    request: u64,
    hwnd_value: isize,
    message: &str,
) {
    if request_id.load(Ordering::Relaxed) != request {
        return;
    }
    if let Ok(mut state) = shared.lock() {
        state.lines = vec![line(message, LineStyle::Error, 0.0)];
        state.loading = false;
        state.request_status = "请求失败".to_string();
    }
    unsafe {
        let hwnd = HWND(hwnd_value as *mut c_void);
        let _ = PostMessageW(Some(hwnd), WM_APP_QUERY_RESULT, WPARAM(0), LPARAM(0));
    }
}

unsafe fn start_selection_lookup(context: &mut AppContext) {
    show_panel(context);
    let shared = context.shared.clone();
    let request_id = context.request_id.clone();
    let hwnd_value = context.hwnd.0 as isize;
    let request = context.request_id.fetch_add(1, Ordering::Relaxed) + 1;
    if let Ok(mut state) = shared.lock() {
        state.loading = true;
        state.active_kind = QueryKind::Word;
        state.request_status = "正在读取选中文本…".to_string();
        state.lines = vec![line("正在读取选中文本…", LineStyle::Muted, 0.0)];
    }
    let _ = InvalidateRect(Some(context.hwnd), None, false);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(70));
        send_ctrl_c();
        thread::sleep(Duration::from_millis(90));
        let text = read_clipboard_text().unwrap_or_default();
        if text.is_empty() {
            finish_error(
                shared,
                request_id,
                request,
                hwnd_value,
                "未读取到选中文本，请重新选择后按 Alt+D",
            );
        } else {
            perform_lookup(
                QueryKind::Word,
                text,
                request,
                shared,
                request_id,
                hwnd_value,
            );
        }
    });
}

unsafe fn send_ctrl_c() {
    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_CONTROL,
                    wScan: 0,
                    dwFlags: Default::default(),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0x43),
                    wScan: 0,
                    dwFlags: Default::default(),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0x43),
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_CONTROL,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
    ];
    let _ = SendInput(&inputs, size_of::<INPUT>() as i32);
}

unsafe fn read_clipboard_text() -> Option<String> {
    for _ in 0..4 {
        if OpenClipboard(None).is_ok() {
            let result = GetClipboardData(CF_UNICODETEXT).ok().and_then(|handle| {
                let hglobal = HGLOBAL(handle.0);
                let size = GlobalSize(hglobal);
                let pointer = GlobalLock(hglobal);
                if pointer.is_null() || size < 2 {
                    let _ = GlobalUnlock(hglobal);
                    return None;
                }
                let units = (size / 2).min(8192);
                let slice = slice::from_raw_parts(pointer as *const u16, units);
                let length = slice.iter().position(|value| *value == 0).unwrap_or(units);
                let text = String::from_utf16_lossy(&slice[..length])
                    .trim()
                    .to_string();
                let _ = GlobalUnlock(hglobal);
                Some(text)
            });
            let _ = CloseClipboard();
            return result;
        }
        thread::sleep(Duration::from_millis(20));
    }
    None
}

unsafe fn write_clipboard_text(text: &str) -> bool {
    if OpenClipboard(None).is_err() {
        return false;
    }
    let wide = text
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let bytes = wide.len() * size_of::<u16>();
    let hglobal = match GlobalAlloc(GMEM_MOVEABLE, bytes) {
        Ok(value) => value,
        Err(_) => {
            let _ = CloseClipboard();
            return false;
        }
    };
    if hglobal.is_invalid() {
        let _ = CloseClipboard();
        return false;
    }
    let pointer = GlobalLock(hglobal) as *mut u16;
    if pointer.is_null() {
        let _ = GlobalFree(Some(hglobal));
        let _ = CloseClipboard();
        return false;
    }
    std::ptr::copy_nonoverlapping(wide.as_ptr(), pointer, wide.len());
    let _ = GlobalUnlock(hglobal);
    if EmptyClipboard().is_err() {
        let _ = GlobalFree(Some(hglobal));
        let _ = CloseClipboard();
        return false;
    }
    let result = SetClipboardData(CF_UNICODETEXT, Some(HANDLE(hglobal.0))).is_ok();
    if !result {
        let _ = GlobalFree(Some(hglobal));
    }
    let _ = CloseClipboard();
    result
}

unsafe fn sync_scrollbar(context: &mut AppContext) {
    let mut rect = RECT::default();
    let _ = GetClientRect(context.hwnd, &mut rect);
    let width = (rect.right - rect.left).max(260) as u32;
    let viewport = (rect.bottom - rect.top - modern_d2d::RESULT_TOP).max(120);
    let lines = context
        .shared
        .lock()
        .map(|state| state.lines.clone())
        .unwrap_or_default();
    context.content_height = Renderer::content_height(&lines, width);
    let max_scroll = (context.content_height - viewport).max(0);
    context.scroll_y = context.scroll_y.clamp(0, max_scroll);
    let _ = ShowWindow(
        context.scrollbar,
        if max_scroll > 0 { SW_SHOW } else { SW_HIDE },
    );
    let info = SCROLLINFO {
        cbSize: size_of::<SCROLLINFO>() as u32,
        fMask: SIF_RANGE | SIF_PAGE | SIF_POS,
        nMin: 0,
        nMax: viewport + max_scroll,
        nPage: viewport as u32,
        nPos: context.scroll_y,
        nTrackPos: 0,
    };
    let _ = SetScrollInfo(context.scrollbar, SB_CTL, &info, true);
}

unsafe fn handle_scroll(context: &mut AppContext, command: i32, track_position: i16) {
    let mut next = context.scroll_y;
    let mut rect = RECT::default();
    let _ = GetClientRect(context.hwnd, &mut rect);
    let viewport = (rect.bottom - rect.top - modern_d2d::RESULT_TOP).max(120);
    let max_scroll = (context.content_height - viewport).max(0);
    match command {
        value if value == SB_LINEUP.0 => next -= 24,
        value if value == SB_LINEDOWN.0 => next += 24,
        value if value == SB_PAGEUP.0 => next -= 260,
        value if value == SB_PAGEDOWN.0 => next += 260,
        value if value == SB_TOP.0 => next = 0,
        value if value == SB_BOTTOM.0 => next = max_scroll,
        value if value == SB_THUMBPOSITION.0 || value == SB_THUMBTRACK.0 => {
            next = i32::from(track_position)
        }
        _ => {}
    }
    context.scroll_y = next.max(0).min(max_scroll);
    sync_scrollbar(context);
    let _ = InvalidateRect(Some(context.hwnd), None, false);
}

unsafe fn add_tray_icon(hwnd: HWND) {
    let mut data = NOTIFYICONDATAW::default();
    data.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
    data.hWnd = hwnd;
    data.uID = TRAY_ID;
    data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    data.uCallbackMessage = WM_APP_TRAY;
    data.hIcon = GetModuleHandleW(None)
        .ok()
        .map(|value| HINSTANCE(value.0))
        .and_then(|instance| LoadIconW(Some(instance), APP_ICON_RESOURCE).ok())
        .or_else(|| LoadIconW(None, IDI_APPLICATION).ok())
        .unwrap_or_default();
    let tip = "Medict Native".encode_utf16().collect::<Vec<_>>();
    for (index, value) in tip.into_iter().enumerate() {
        if index + 1 >= data.szTip.len() {
            break;
        }
        data.szTip[index] = value;
    }
    let _ = Shell_NotifyIconW(NIM_ADD, &data);
}

unsafe fn remove_tray_icon(hwnd: HWND) {
    let mut data = NOTIFYICONDATAW::default();
    data.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
    data.hWnd = hwnd;
    data.uID = TRAY_ID;
    let _ = Shell_NotifyIconW(NIM_DELETE, &data);
}

unsafe fn handle_tray_message(context: &mut AppContext, message: u32) -> LRESULT {
    const WM_LBUTTONUP_VALUE: u32 = 0x0202;
    const WM_LBUTTONDBLCLK_VALUE: u32 = 0x0203;
    const WM_RBUTTONUP_VALUE: u32 = 0x0205;
    if message == WM_LBUTTONUP_VALUE || message == WM_LBUTTONDBLCLK_VALUE {
        show_panel(context);
        return LRESULT(0);
    }
    if message == WM_RBUTTONUP_VALUE {
        let menu = match CreatePopupMenu() {
            Ok(menu) => menu,
            Err(_) => return LRESULT(0),
        };
        let _ = AppendMenuW(menu, MF_STRING, MENU_SHOW, w!("显示 Medict"));
        let _ = AppendMenuW(menu, MF_STRING, MENU_EXIT, w!("退出"));
        let mut point = POINT::default();
        let _ = GetCursorPos(&mut point);
        let _ = SetForegroundWindow(context.hwnd);
        let command = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_NONOTIFY,
            point.x,
            point.y,
            Some(0),
            context.hwnd,
            None,
        );
        let _ = DestroyMenu(menu);
        match command.0 as usize {
            MENU_SHOW => show_panel(context),
            MENU_EXIT => {
                let _ = DestroyWindow(context.hwnd);
            }
            _ => {}
        }
    }
    LRESULT(0)
}

fn word_lines(query: &str, value: &Value) -> Vec<DisplayLine> {
    let mut lines = Vec::new();
    let success = value
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let title = value.get("query").and_then(Value::as_str).unwrap_or(query);
    let results = value
        .get("dictionaryResults")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for result in results {
        let name = result
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("在线词典");
        lines.push(line(name, LineStyle::Section, 0.0));
        let word = result.get("word").and_then(Value::as_str).unwrap_or(title);
        let phonetic = result
            .get("phonetic")
            .and_then(Value::as_str)
            .unwrap_or_default();
        lines.push(line(
            if phonetic.is_empty() {
                word.to_string()
            } else {
                format!("{word}  {phonetic}")
            },
            LineStyle::Body,
            0.0,
        ));
        for sense in result
            .get("senses")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let part = sense
                .get("partOfSpeech")
                .and_then(Value::as_str)
                .unwrap_or("释义");
            lines.push(line(part, LineStyle::Muted, 8.0));
            for translation in sense
                .get("translations")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                lines.push(line(format!("• {translation}"), LineStyle::Body, 18.0));
            }
            if let Some(definition) = sense.get("definition").and_then(Value::as_str) {
                lines.push(line(definition, LineStyle::Body, 18.0));
            }
        }
        let examples = result
            .get("examples")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !examples.is_empty() {
            lines.push(line("双语例句", LineStyle::Section, 0.0));
            for example in examples.iter().take(5) {
                if let Some(text) = example.get("text").and_then(Value::as_str) {
                    lines.push(line(format!("例  {text}"), LineStyle::Body, 12.0));
                } else if let Some(text) = example.get("example").and_then(Value::as_str) {
                    lines.push(line(format!("例  {text}"), LineStyle::Body, 12.0));
                }
                if let Some(translation) = example.get("translation").and_then(Value::as_str) {
                    lines.push(line(translation, LineStyle::Muted, 28.0));
                }
            }
        }
    }
    for result in value
        .get("cloudResults")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        lines.push(line(
            result
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("在线翻译"),
            LineStyle::Section,
            0.0,
        ));
        for translation in result
            .get("translations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            lines.push(line(translation, LineStyle::Body, 10.0));
        }
    }
    if !success && lines.is_empty() {
        lines.push(line("没有找到可显示的词典结果。", LineStyle::Muted, 0.0));
    }
    for warning in value
        .get("warnings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        lines.push(line(format!("提示：{warning}"), LineStyle::Muted, 0.0));
    }
    lines
}

fn drug_lines(value: &Value) -> Vec<DisplayLine> {
    let mut lines = Vec::new();
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("未识别药物");
    lines.push(line(name, LineStyle::Heading, 0.0));
    let success = value
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !success {
        lines.push(line("未找到该药物的可靠身份记录。", LineStyle::Error, 0.0));
    }
    let identifiers = value.get("identifiers").unwrap_or(&Value::Null);
    if let Some(rxcui) = identifiers.get("rxcui").and_then(Value::as_str) {
        lines.push(line(format!("RxCUI：{rxcui}"), LineStyle::Body, 0.0));
    }
    let names = value.get("names").unwrap_or(&Value::Null);
    append_value_list(&mut lines, "商品名", names.get("brands"), LineStyle::Body);
    append_value_list(&mut lines, "通用名", names.get("generic"), LineStyle::Body);
    if let Some(phase) = value
        .get("development")
        .and_then(|item| item.get("maxPhase"))
        .and_then(Value::as_f64)
    {
        lines.push(line(format!("最高开发阶段：{phase}"), LineStyle::Body, 0.0));
    }
    append_object_section(&mut lines, "临床试验", value.get("trials"));
    append_object_section(&mut lines, "FDA 获批记录", value.get("approvals"));
    append_object_section(&mut lines, "作用机制", value.get("mechanisms"));
    append_object_section(&mut lines, "原始数据源", value.get("sources"));
    append_value_list(&mut lines, "警告", value.get("warnings"), LineStyle::Muted);
    lines
}

fn append_value_list(
    lines: &mut Vec<DisplayLine>,
    title: &str,
    value: Option<&Value>,
    style: LineStyle,
) {
    let Some(rows) = value.and_then(Value::as_array) else {
        return;
    };
    if rows.is_empty() {
        return;
    }
    lines.push(line(title, LineStyle::Section, 0.0));
    for row in rows.iter().take(12) {
        if let Some(text) = row.as_str() {
            lines.push(line(format!("• {text}"), style, 10.0));
        }
    }
}

fn append_object_section(lines: &mut Vec<DisplayLine>, title: &str, value: Option<&Value>) {
    let Some(value) = value else {
        return;
    };
    let has_rows = value
        .as_array()
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);
    let has_object = value
        .as_object()
        .map(|object| !object.is_empty())
        .unwrap_or(false);
    if !has_rows && !has_object {
        return;
    }
    lines.push(line(title, LineStyle::Section, 0.0));
    if let Some(rows) = value.as_array() {
        for row in rows.iter().take(8) {
            let summary = row
                .get("title")
                .or_else(|| row.get("name"))
                .or_else(|| row.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| row.to_string());
            lines.push(line(format!("• {summary}"), LineStyle::Body, 10.0));
        }
    } else if let Some(object) = value.as_object() {
        for (key, item) in object.iter().take(8) {
            let text = item
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| item.to_string());
            lines.push(line(format!("{key}：{text}"), LineStyle::Body, 10.0));
        }
    }
}

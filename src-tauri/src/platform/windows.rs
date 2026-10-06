// Windows: Win32 for the island window and the cursor, %APPDATA% for files.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

use tauri::{AppHandle, Manager, WebviewWindow};

use ::windows::core::{BOOL, PWSTR};
use ::windows::Win32::Foundation::{
    CloseHandle, HANDLE, HLOCAL, HWND, LPARAM, LocalFree, POINT, RECT,
};
use ::windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits,
    GetWindowDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    SRCCOPY,
};
use ::windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use ::windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use ::windows::Win32::System::Ole::RevokeDragDrop;
use ::windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use ::windows::Win32::System::SystemInformation::{GetLocalTime, GetTickCount};
use ::windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use ::windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetLastInputInfo, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE,
    KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, LASTINPUTINFO, MOUSEINPUT, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, VK_LBUTTON, VIRTUAL_KEY,
};
use ::windows::Win32::UI::Accessibility::{IUIAutomation, CUIAutomation};
use ::windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindowLongPtrW,
    GetWindowTextW, GetWindowTextLengthW, GetWindowThreadProcessId, GetWindowRect, IsChild,
    IsWindow, SetForegroundWindow, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};

use super::LocalTime;
use crate::island::WINDOW_LABEL;

/// File name of the Claude Code relay.
pub const HOOK_EXE: &str = "act3-hook.exe";

/// Environment variable holding the home directory.
pub const HOME_VAR: &str = "USERPROFILE";

/// Keeps spawned helpers from flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Files ─────────────────────────────────────────────────────────────────────

/// %APPDATA%\ACT 3 — preferences.
pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("ACT 3")
}

/// %LOCALAPPDATA%\ACT 3 — where act3-hook.exe, the inbox and the log live.
pub fn local_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("ACT 3")
}

/// %APPDATA% and %LOCALAPPDATA% are already private to the user.
pub fn ensure_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// Nothing to set up before the webview starts.
pub fn prepare_environment() {}

pub fn local_time() -> LocalTime {
    let t = unsafe { GetLocalTime() };
    LocalTime {
        year: t.wYear.into(),
        month: t.wMonth.into(),
        day: t.wDay.into(),
        hour: t.wHour.into(),
        minute: t.wMinute.into(),
        second: t.wSecond.into(),
    }
}

// ── Processes ─────────────────────────────────────────────────────────────────

/// Spawned helpers must never flash a console window.
pub fn no_console(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}

pub fn open_url(url: &str) {
    let _ = no_console(Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url]))
        .spawn();
}

pub fn reveal_folder(path: &str) {
    let _ = Command::new("explorer").arg(path).spawn();
}

pub fn reveal_path(path: &str) -> Result<(), String> {
    no_console(&mut Command::new("explorer.exe"))
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the selected file: {error}"))
}

/// Our own `where`: walks %PATH% against %PATHEXT%, no shell involved.
/// Rust quotes arguments correctly for `.cmd`/`.bat` targets since 1.77, so
/// spawning `code.cmd` directly is safe.
pub fn find_on_path(stem: &str) -> Option<PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let dirs = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&dirs) {
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let candidate = dir.join(format!("{stem}{}", ext.to_lowercase()));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

// ── Who we are ────────────────────────────────────────────────────────────────
//
// Named pipes share one machine-wide namespace, so the SID in the name is what
// keeps two accounts on the same machine from ever meeting on `act3-*`.
// act3-hook computes the same string (hook/src/win.rs) and additionally checks
// that the process serving the pipe really is us.

/// The SID of the account this process runs as, as `S-1-5-21-…`.
pub fn current_user_sid() -> Option<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;

        // First call sizes the buffer, second fills it.
        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        if needed == 0 {
            let _ = CloseHandle(token);
            return None;
        }
        let mut buf = vec![0u8; needed as usize];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr().cast()),
            needed,
            &mut needed,
        )
        .is_ok();
        let _ = CloseHandle(token);
        if !ok {
            return None;
        }

        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text).ok()?;
        let sid = text.to_string().ok();
        let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
        sid
    }
}

// ── Cursor ────────────────────────────────────────────────────────────────────

/// The 60 Hz poll reads the cursor and flips click-through from it.
pub const CURSOR_POLL: bool = true;

/// Cursor position in physical screen pixels.
pub fn cursor_physical() -> Option<(f64, f64)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x as f64, p.y as f64))
}

/// True while the left mouse button is held — the only signal we get that a
/// drag might be in flight before it reaches the window.
pub fn left_button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

/// Seconds since the user's last keyboard or mouse input across Windows.
pub fn system_idle_seconds() -> Result<u64, String> {
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    unsafe { GetLastInputInfo(&mut info) }
        .ok()
        .map_err(|error| format!("Could not read Windows idle time: {error}"))?;
    let elapsed_ms = unsafe { GetTickCount() }.wrapping_sub(info.dwTime);
    Ok(u64::from(elapsed_ms / 1000))
}

pub fn foreground_window_context(excluded_hwnd: Option<isize>) -> Option<super::WindowContext> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() || excluded_hwnd.is_some_and(|excluded| excluded == hwnd.0 as isize) {
        return None;
    }
    window_context(hwnd)
}

fn window_context(hwnd: HWND) -> Option<super::WindowContext> {
    let length = unsafe { GetWindowTextLengthW(hwnd) };
    if length <= 0 {
        return None;
    }
    let mut title = vec![0u16; (length as usize + 1).min(2049)];
    let copied = unsafe { GetWindowTextW(hwnd, &mut title) };
    if copied <= 0 {
        return None;
    }
    title.truncate(copied as usize);
    let title = String::from_utf16_lossy(&title).trim().to_string();
    if title.is_empty() {
        return None;
    }

    let mut process_id = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
    let app_name = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok() }
        .map(|process| {
            let mut image = vec![0u16; 1024];
            let mut image_len = image.len() as u32;
            let result = unsafe {
                QueryFullProcessImageNameW(
                    process,
                    PROCESS_NAME_FORMAT(0),
                    ::windows::core::PWSTR(image.as_mut_ptr()),
                    &mut image_len,
                )
            };
            unsafe {
                let _ = CloseHandle(process);
            }
            if result.is_ok() {
                image.truncate(image_len as usize);
                std::path::Path::new(&String::from_utf16_lossy(&image))
                    .file_stem()
                    .map(|name| name.to_string_lossy().to_string())
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| "Active app".into())
            } else {
                "Active app".into()
            }
        })
        .unwrap_or_else(|| "Active app".into());
    Some(super::WindowContext {
        app_name,
        title,
        window_id: hwnd.0 as isize,
    })
}

pub fn capture_window(window_id: isize) -> Result<super::WindowCapture, String> {
    let hwnd = HWND(window_id as *mut _);
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return Err("The selected app window is no longer available. Share it again.".into());
    }
    let context = window_context(hwnd)
        .ok_or_else(|| {
            "The selected app window is no longer available. Select it again before sharing."
                .to_string()
        })?;
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }
        .map_err(|error| format!("Could not read the selected window bounds: {error}"))?;
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if !(1..=3840).contains(&width) || !(1..=2160).contains(&height) {
        return Err("The selected window has unsupported dimensions (maximum 3840 x 2160).".into());
    }

    let window_dc = unsafe { GetWindowDC(Some(hwnd)) };
    if window_dc.is_invalid() {
        return Err("Could not capture the selected window.".into());
    }
    let memory_dc = unsafe { CreateCompatibleDC(Some(window_dc)) };
    if memory_dc.is_invalid() {
        unsafe { ReleaseDC(Some(hwnd), window_dc) };
        return Err("Could not prepare a temporary window capture.".into());
    }
    let bitmap = unsafe { CreateCompatibleBitmap(window_dc, width, height) };
    if bitmap.is_invalid() {
        unsafe {
            let _ = DeleteDC(memory_dc);
            ReleaseDC(Some(hwnd), window_dc);
        }
        return Err("Could not allocate a temporary window capture.".into());
    }
    let previous = unsafe { SelectObject(memory_dc, bitmap.into()) };
    let copied = unsafe {
        BitBlt(
            memory_dc,
            0,
            0,
            width,
            height,
            Some(window_dc),
            0,
            0,
            SRCCOPY,
        )
    };
    if let Err(error) = copied {
        unsafe {
            SelectObject(memory_dc, previous);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(memory_dc);
            ReleaseDC(Some(hwnd), window_dc);
        }
        return Err(format!("Could not capture the selected window: {error}"));
    }

    let mut info = BITMAPINFO::default();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let mut bgra = vec![0u8; width as usize * height as usize * 4];
    let lines = unsafe {
        GetDIBits(
            memory_dc,
            bitmap,
            0,
            height as u32,
            Some(bgra.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        SelectObject(memory_dc, previous);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory_dc);
        ReleaseDC(Some(hwnd), window_dc);
    }
    if lines != height {
        return Err("Windows could not read all pixels from the selected window.".into());
    }
    let mut rgba = Vec::with_capacity(bgra.len());
    for pixel in bgra.chunks_exact(4) {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
    }
    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("Could not encode the screenshot: {error}"))?;
        writer
            .write_image_data(&rgba)
            .map_err(|error| format!("Could not encode the screenshot: {error}"))?;
    }
    if png_bytes.len() > 5 * 1024 * 1024 {
        return Err("The selected window image is larger than the 5 MB sharing limit.".into());
    }
    Ok(super::WindowCapture {
        app_name: context.app_name,
        title: context.title,
        window_id,
        width: width as u32,
        height: height as u32,
        png_base64: crate::claude::base64_for(&png_bytes),
    })
}

fn focused_control_is_password(target: HWND) -> Result<bool, String> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|error| format!("Could not check the focused field safely: {error}"))?;
    let result = (|| {
        let automation: IUIAutomation = unsafe {
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
        }
        .map_err(|error| format!("Could not check the focused field safely: {error}"))?;
        let focused = unsafe { automation.GetFocusedElement() }
            .map_err(|error| format!("Could not inspect the focused field: {error}"))?;
        let focused_hwnd = unsafe { focused.CurrentNativeWindowHandle() }
            .map_err(|error| format!("Could not identify the focused field: {error}"))?;
        if focused_hwnd != target && !unsafe { IsChild(target, focused_hwnd) }.as_bool() {
            return Err("The focused field is not inside the selected app window.".into());
        }
        let is_password = unsafe { focused.CurrentIsPassword() }
            .map_err(|error| {
                format!("Could not verify the focused field is not a password field: {error}")
            })?;
        Ok(is_password.as_bool())
    })();
    unsafe { CoUninitialize() };
    result
}

pub fn perform_window_action(
    window_id: isize,
    expected_app_name: &str,
    expected_title: &str,
    expected_width: u32,
    expected_height: u32,
    action: super::WindowAction,
) -> Result<(), String> {
    let hwnd = HWND(window_id as *mut _);
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return Err("The selected app window is no longer available.".into());
    }
    let context = window_context(hwnd)
        .ok_or_else(|| "The selected app window is no longer available.".to_string())?;
    if context.app_name != expected_app_name || context.title != expected_title {
        return Err("The selected window changed since capture. Share it again before approving an action.".into());
    }
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }
        .map_err(|error| format!("Could not check the selected window bounds: {error}"))?;
    if rect.right - rect.left != expected_width as i32
        || rect.bottom - rect.top != expected_height as i32
    {
        return Err("The selected window size changed since capture. Share it again before approving an action.".into());
    }
    let _ = unsafe { SetForegroundWindow(hwnd) };
    std::thread::sleep(std::time::Duration::from_millis(100));
    if unsafe { GetForegroundWindow() } != hwnd {
        return Err("Windows did not focus the selected app. Nothing was typed or clicked.".into());
    }
    match action {
        super::WindowAction::Click { x, y } => {
            let mut rect = RECT::default();
            unsafe { GetWindowRect(hwnd, &mut rect) }
                .map_err(|error| format!("Could not check the selected window bounds: {error}"))?;
            if x < 0 || y < 0 || x >= rect.right - rect.left || y >= rect.bottom - rect.top {
                return Err("The approved click is outside the selected window.".into());
            }
            unsafe {
                ::windows::Win32::UI::WindowsAndMessaging::SetCursorPos(rect.left + x, rect.top + y)
            }
            .map_err(|error| format!("Could not position the approved click: {error}"))?;
            let inputs = [
                INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dwFlags: MOUSEEVENTF_LEFTDOWN,
                            ..Default::default()
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dwFlags: MOUSEEVENTF_LEFTUP,
                            ..Default::default()
                        },
                    },
                },
            ];
            if unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) }
                != inputs.len() as u32
            {
                return Err("Windows did not complete the approved click.".into());
            }
            Ok(())
        }
        super::WindowAction::Type { text } => {
            if text.trim().is_empty()
                || text.chars().count() > 300
                || text.chars().any(char::is_control)
            {
                return Err("Typed text must be 1-300 printable characters.".into());
            }
            if focused_control_is_password(hwnd)? {
                return Err("Typing into password fields is blocked.".into());
            }
            let mut inputs = Vec::with_capacity(text.encode_utf16().count() * 2);
            for unit in text.encode_utf16() {
                inputs.push(INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wScan: unit,
                            dwFlags: KEYEVENTF_UNICODE,
                            ..Default::default()
                        },
                    },
                });
                inputs.push(INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wScan: unit,
                            dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                            ..Default::default()
                        },
                    },
                });
            }
            if unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) }
                != inputs.len() as u32
            {
                return Err("Windows did not type the complete approved text.".into());
            }
            Ok(())
        }
        super::WindowAction::Hotkey { keys } => {
            if keys.len() != 1 {
                return Err("Only one standalone navigation key can be sent at a time.".into());
            }
            let vk = match keys[0].as_str() {
                "ENTER" => 0x0D,
                "TAB" => 0x09,
                "ESC" => 0x1B,
                "UP" => 0x26,
                "DOWN" => 0x28,
                "LEFT" => 0x25,
                "RIGHT" => 0x27,
                _ => return Err("That key is not in ACT 3's allowed hotkey list.".into()),
            };
            let inputs = [
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VIRTUAL_KEY(vk),
                            ..Default::default()
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VIRTUAL_KEY(vk),
                            dwFlags: KEYEVENTF_KEYUP,
                            ..Default::default()
                        },
                    },
                },
            ];
            if unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) }
                != inputs.len() as u32
            {
                return Err("Windows did not complete the approved key press.".into());
            }
            Ok(())
        }
    }
}

// ── Island window ─────────────────────────────────────────────────────────────

fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
    let raw = win.hwnd().ok()?.0 as isize;
    if raw == 0 {
        return None;
    }
    Some(HWND(raw as *mut _))
}

/// Lets dropped files reach the app again.
///
/// wry installs its drop target by walking the webview's child windows **once**,
/// when the webview is created. WebView2 creates `Chrome_RenderWidgetHostHWND`
/// later and registers its own target on it; being the innermost window, that one
/// wins, and since the page has no HTML5 drop handler it refuses everything — the
/// "no drop" cursor, with nothing reaching Tauri. Revoking it makes OLE fall
/// through to the target wry registered on the parent widget, which is the one
/// that feeds Tauri's drag events.
///
/// Cheap and idempotent, so it is simply re-run whenever a drag might be starting.
pub fn unblock_webview_drops(app: &AppHandle) {
    for label in [WINDOW_LABEL, "settings"] {
        let Some(win) = app.get_webview_window(label) else { continue };
        let Some(hwnd) = hwnd_of(&win) else { continue };
        unsafe {
            let _ = EnumChildWindows(Some(hwnd), Some(revoke_render_widget), LPARAM(0));
        }
    }
}

unsafe extern "system" fn revoke_render_widget(hwnd: HWND, _: LPARAM) -> BOOL {
    let mut name = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, &mut name) };
    if len > 0 {
        let class = String::from_utf16_lossy(&name[..len as usize]);
        if class == "Chrome_RenderWidgetHostHWND" {
            let _ = unsafe { RevokeDragDrop(hwnd) };
        }
    }
    true.into()
}

/// WS_EX_NOACTIVATE keeps clicks from stealing focus; WS_EX_TOOLWINDOW keeps the
/// island out of Alt-Tab.
pub fn make_non_activating(win: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// Temporarily allow activation so a text field inside the island can be typed in.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = if activating {
            ex & !(WS_EX_NOACTIVATE.0 as isize)
        } else {
            ex | WS_EX_NOACTIVATE.0 as isize
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// Click-through here is the poll's WS_EX_TRANSPARENT toggle, not a region.
pub fn set_input_region(_win: &WebviewWindow, _rect: Option<(f64, f64, f64, f64)>) {}

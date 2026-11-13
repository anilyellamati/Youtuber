//! Windows helpers: connected displays and open windows, for the source dropdown.

use std::ptr::null_mut;

use winapi::shared::minwindef::{BOOL, LPARAM, TRUE};
use winapi::shared::windef::{HDC, HMONITOR, HWND, LPRECT, RECT};
use winapi::um::winuser::{
    EnumDisplayMonitors, EnumWindows, GetWindowLongW, GetWindowRect, GetWindowTextW, IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

use crate::core::Source;

/// A rectangle in virtual-desktop pixels.
#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

unsafe extern "system" fn mon_cb(_m: HMONITOR, _dc: HDC, r: LPRECT, l: LPARAM) -> BOOL {
    let list = &mut *(l as *mut Vec<Rect>);
    let r = &*r;
    list.push(Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top });
    TRUE
}

/// Connected displays, primary first (the primary display sits at 0,0).
pub fn monitors() -> Vec<Rect> {
    let mut list: Vec<Rect> = Vec::new();
    unsafe {
        EnumDisplayMonitors(null_mut(), std::ptr::null(), Some(mon_cb), &mut list as *mut _ as LPARAM);
    }
    list.sort_by_key(|m| !(m.x == 0 && m.y == 0));
    list
}

unsafe extern "system" fn win_cb(h: HWND, l: LPARAM) -> BOOL {
    if IsWindowVisible(h) == 0 || IsIconic(h) != 0 {
        return TRUE;
    }
    if GetWindowLongW(h, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW != 0 {
        return TRUE;
    }
    let mut buf = [0u16; 200];
    let n = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32);
    if n <= 0 {
        return TRUE;
    }
    let title = String::from_utf16_lossy(&buf[..n as usize]);
    if title == "Program Manager" || title == "StreamForge Rec" {
        return TRUE;
    }
    let mut r: RECT = std::mem::zeroed();
    if GetWindowRect(h, &mut r) == 0 || r.right - r.left < 120 || r.bottom - r.top < 90 {
        return TRUE;
    }
    let list = &mut *(l as *mut Vec<(String, Rect)>);
    list.push((title, Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }));
    TRUE
}

/// Open, visible windows with a title.
pub fn windows() -> Vec<(String, Rect)> {
    let mut list: Vec<(String, Rect)> = Vec::new();
    unsafe {
        EnumWindows(Some(win_cb), &mut list as *mut _ as LPARAM);
    }
    list
}

pub fn display_source(index: usize, m: &Rect) -> Source {
    Source { output: index as u32, region: None, virt: Some((m.x, m.y, m.w & !1, m.h & !1)) }
}

/// A window is captured as its area of the display it is on (GPU-friendly, works
/// with games). The area is fixed when recording starts.
pub fn window_source(w: &Rect, mons: &[Rect]) -> Option<Source> {
    let (cx, cy) = (w.x + w.w / 2, w.y + w.h / 2);
    let (idx, m) = mons.iter().enumerate().find(|(_, m)| cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h)?;
    let x0 = w.x.max(m.x);
    let y0 = w.y.max(m.y);
    let x1 = (w.x + w.w).min(m.x + m.w);
    let y1 = (w.y + w.h).min(m.y + m.h);
    let (ww, hh) = ((x1 - x0) & !1, (y1 - y0) & !1);
    if ww < 64 || hh < 64 {
        return None;
    }
    Some(Source { output: idx as u32, region: Some((x0 - m.x, y0 - m.y, ww, hh)), virt: Some((x0, y0, ww, hh)) })
}

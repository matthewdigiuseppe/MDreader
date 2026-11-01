// MDreader desktop shell. The editor itself is the web app in the repo root;
// this file adds native menus, file access and Finder integration.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;
use std::sync::Mutex;

use base64::Engine;
use serde::Serialize;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, Wry};

/// Files the OS asked us to open (Finder double-click, `open -a`, CLI args)
/// that the web view has not picked up yet.
struct Pending(Mutex<Vec<String>>);

const MARKDOWN_EXTS: [&str; 5] = ["md", "markdown", "mdown", "mkd", "txt"];

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    children: Option<Vec<Entry>>,
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Read a local file (usually an image referenced by the document) as a data URL.
#[tauri::command]
fn read_data_url(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let ext = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        _ => "application/octet-stream",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|x| x.to_str())
        .map(|x| MARKDOWN_EXTS.contains(&x.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn walk(dir: &Path, depth: usize) -> Vec<Entry> {
    let mut out = Vec::new();
    if depth > 5 {
        return out;
    }
    let Ok(read) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in read.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        if path.is_dir() {
            let kids = walk(&path, depth + 1);
            if !kids.is_empty() {
                out.push(Entry { name, path: path.to_string_lossy().into_owned(), children: Some(kids) });
            }
        } else if is_markdown(&path) {
            out.push(Entry { name, path: path.to_string_lossy().into_owned(), children: None });
        }
    }
    // folders first, then natural-ish alphabetical order
    out.sort_by(|a, b| {
        (a.children.is_none(), a.name.to_lowercase()).cmp(&(b.children.is_none(), b.name.to_lowercase()))
    });
    out
}

/// Markdown files under a folder, as a tree.
#[tauri::command]
fn list_markdown(dir: String) -> Vec<Entry> {
    walk(Path::new(&dir), 0)
}

#[derive(Serialize)]
struct Stat {
    modified: u64,
    size: u64,
}

/// Modification time (ms since epoch) and size, used to watch open files.
#[tauri::command]
fn file_stat(path: String) -> Result<Stat, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(Stat { modified, size: meta.len() })
}

/// Files directly inside `dir` with the given extension (e.g. "bib").
#[tauri::command]
fn list_files(dir: String, ext: String) -> Vec<String> {
    let ext = ext.to_lowercase();
    let mut out: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .filter(|p| p.extension().and_then(|x| x.to_str()).map(|x| x.to_lowercase() == ext).unwrap_or(false))
                .map(|p| p.to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

#[tauri::command]
fn take_opened_files(state: State<'_, Pending>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

#[tauri::command]
fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, label: &str, accel: Option<&str>| MenuItem::with_id(app, id, label, true, accel);

    let app_menu = Submenu::with_items(
        app,
        "MDreader",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About MDreader"), Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &item("quit", "Quit MDreader", Some("CmdOrCtrl+Q"))?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item("new", "New", Some("CmdOrCtrl+N"))?,
            &item("open", "Open…", Some("CmdOrCtrl+O"))?,
            &item("openFolder", "Open Folder…", Some("CmdOrCtrl+Shift+O"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("save", "Save", Some("CmdOrCtrl+S"))?,
            &item("saveAs", "Save As…", Some("CmdOrCtrl+Shift+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("loadBib", "Load Bibliography…", Some("CmdOrCtrl+Shift+B"))?,
            &item("exportHtml", "Export as HTML…", None)?,
            &item("print", "Print…", Some("CmdOrCtrl+P"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item("sidebar", "Toggle Sidebar", Some("CmdOrCtrl+\\"))?,
            &item("source", "Source Mode", Some("CmdOrCtrl+/"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("watch", "Reload When File Changes", None)?,
            &item("lock", "Reading Lock", Some("CmdOrCtrl+Shift+L"))?,
            &item("focus", "Focus Mode", Some("F8"))?,
            &item("typewriter", "Typewriter Mode", Some("F9"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
}

fn main() {
    let initial: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-') && Path::new(a).is_file())
        .collect();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Pending(Mutex::new(initial)))
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.clone());
        })
        .invoke_handler(tauri::generate_handler![
            read_text,
            write_text,
            read_data_url,
            list_markdown,
            file_stat,
            list_files,
            take_opened_files,
            print_page,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("error while building MDreader");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Opened { urls } = &event {
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if let Some(state) = app.try_state::<Pending>() {
                state.0.lock().unwrap().extend(paths);
            }
            let _ = app.emit("files-opened", ());
        }
        let _ = (app, event);
    });
}

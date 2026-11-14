mod backups;
mod realcheck;
mod dngout;
mod denoise;
mod depth;
mod dpi;
mod perf;
mod licence;
mod smart;
mod watch;
mod xfer;
mod xmp;
mod book;
mod pdf;
mod object;
mod pano;
mod presence;
mod proof;
mod advisor;
mod aesthetic;
mod catalog;
mod catalogs;
mod develop;
mod geometry;
mod inpaint;
mod masks;
mod mcp;
mod mcp_tools;
mod media;
mod merge;
mod colour;
mod cull;
mod export;
mod faces;
mod portrait;
mod parsing;
mod redeye;
mod spots;
mod subject;
mod upscale;

use catalog::{Catalog, CollectionRow, DevelopState, PresetRow, SnapshotRow, FolderRow, KeywordRow, KeywordUse, MetaPatch, MetaView, Page, Query, StepIn};
use develop::Recipe;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

/// One open catalog. The preview folder is kept separately so the image protocol
/// never waits on a long database operation.
#[derive(Clone)]
pub struct AppState {
    cat: Arc<Mutex<Option<Catalog>>>,
    previews: Arc<Mutex<PathBuf>>,
    /// The last proxy image used by the Develop view, so dragging a slider does not decode the JPEG every time.
    proxy: Arc<Mutex<Option<(i64, u32, Arc<image::RgbImage>)>>>,
    /// The full-size picture of the photo being viewed at 1:1, and the same picture cropped by the recipe.
    full: Arc<Mutex<Option<FullCache>>>,
    /// Per photo, which request for edited previews is the newest, so a slow older one never overwrites a newer one.
    edit_gen: Arc<Mutex<std::collections::HashMap<i64, u64>>>,
    /// The folder the person is choosing photos from, so only its files are ever served as thumbnails.
    import_root: Arc<Mutex<Option<PathBuf>>>,
    /// The catalogs the person keeps, where that list is saved, and where new catalogs go unless another place is chosen.
    registry: Arc<Mutex<catalogs::Registry>>,
    registry_file: Arc<Mutex<PathBuf>>,
    catalogs_home: Arc<Mutex<PathBuf>>,
    /// The AI connection (MCP): its settings, the server when it is on, and where the settings are saved.
    mcp: Arc<Mutex<McpHandle>>,
    mcp_file: Arc<Mutex<PathBuf>>,
    /// What went wrong the last time sidecar files were written by themselves, if anything.
    xmp_error: Arc<Mutex<Option<String>>>,
    /// Previews that are asked for while they are not there are made one at a time, so a screen full of them cannot use all the memory.
    build_lock: Arc<Mutex<()>>,
    /// The folder being watched for new photos (auto import), and what it has done so far.
    watch: Arc<Mutex<Option<WatchConfig>>>,
    /// The profile Develop is proofing with (soft proofing), when one is chosen.
    proof: Arc<Mutex<Option<Arc<proof::ProofSetup>>>>,
    watch_status: Arc<Mutex<WatchStatus>>,
}

#[derive(Default)]
struct McpHandle {
    settings: McpSettings,
    running: Option<mcp::Running>,
    error: Option<String>,
}

struct FullCache {
    id: i64,
    full: Arc<image::RgbImage>,
    crop_key: String,
    cropped: Arc<image::RgbImage>,
}

/// What the full-size picture was prepared for: the crop and the lens and transform settings.
fn crop_key(r: &Recipe) -> String {
    format!("{}|{}", serde_json::to_string(&r.crop).unwrap_or_default(), serde_json::to_string(&r.geometry).unwrap_or_default())
}

/// Decode the photo at full size (once) and crop it by the recipe (again only when the crop changes).
fn ensure_full(state: &AppState, id: i64, recipe: &Recipe) -> Result<Arc<image::RgbImage>, String> {
    let r = recipe.sanitized();
    let key = crop_key(&r);
    let known_full = {
        let g = state.full.lock().map_err(|_| "busy".to_string())?;
        match g.as_ref() {
            Some(c) if c.id == id && c.crop_key == key => return Ok(c.cropped.clone()),
            Some(c) if c.id == id => Some(c.full.clone()),
            _ => None,
        }
    };
    let full = match known_full {
        Some(f) => f,
        None => {
            let path = state.with(|c| c.photo_path(id))?;
            Arc::new(media::decode_any(&path, false)?.to_rgb8())
        }
    };
    let bent = if r.geometry.is_identity() { full.clone() } else { Arc::new(geometry::apply_geometry(&full, &r.geometry)) };
    let cropped = if r.has_crop() { Arc::new(develop::apply_crop(&bent, &r.crop)) } else { bent };
    *state.full.lock().map_err(|_| "busy".to_string())? = Some(FullCache { id, full, crop_key: key, cropped: cropped.clone() });
    Ok(cropped)
}

impl AppState {
    fn new() -> Self {
        AppState { cat: Arc::new(Mutex::new(None)), previews: Arc::new(Mutex::new(PathBuf::new())), proxy: Arc::new(Mutex::new(None)), full: Arc::new(Mutex::new(None)), edit_gen: Arc::new(Mutex::new(std::collections::HashMap::new())), import_root: Arc::new(Mutex::new(None)), registry: Arc::new(Mutex::new(catalogs::Registry::default())), registry_file: Arc::new(Mutex::new(PathBuf::new())), catalogs_home: Arc::new(Mutex::new(PathBuf::new())), mcp: Arc::new(Mutex::new(McpHandle::default())), mcp_file: Arc::new(Mutex::new(PathBuf::new())), xmp_error: Arc::new(Mutex::new(None)), build_lock: Arc::new(Mutex::new(())), watch: Arc::new(Mutex::new(None)), proof: Arc::new(Mutex::new(None)), watch_status: Arc::new(Mutex::new(WatchStatus::default())) }
    }
    fn with<T>(&self, f: impl FnOnce(&mut Catalog) -> Result<T, String>) -> Result<T, String> {
        let mut g = self.cat.lock().map_err(|_| "The catalog is busy. Try again.".to_string())?;
        let cat = g.as_mut().ok_or_else(|| "No catalog is open.".to_string())?;
        f(cat)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogInfo {
    path: String,
    count: i64,
    /// the name the person gave this catalog
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    images: usize,
    raw: usize,
}

#[derive(Serialize, Clone)]
struct Progress {
    done: usize,
    total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    added: usize,
    duplicates: usize,
    failed: Vec<String>,
    unsupported_previews: usize,
    left_behind: Vec<String>,
    /// the photos that were added, so presets and keywords can be put on them
    added_ids: Vec<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    written: usize,
    failed: Vec<String>,
    /// where the files went (the new folder, when one was asked for)
    folder: String,
    /// the files that were written
    files: Vec<String>,
}

// ---- books ------------------------------------------------------------------------

#[tauri::command]
fn book_list(state: tauri::State<'_, AppState>) -> Result<Vec<catalog::BookEntry>, String> {
    state.with(|c| c.book_list())
}

#[tauri::command]
fn book_create(state: tauri::State<'_, AppState>, name: Option<String>) -> Result<i64, String> {
    let mut b = book::Book::default();
    if let Some(n) = name {
        b.name = n;
    }
    state.with(|c| c.book_create(&b))
}

#[tauri::command]
fn book_get(state: tauri::State<'_, AppState>, id: i64) -> Result<book::Book, String> {
    state.with(|c| c.book_get(id))
}

#[tauri::command]
fn book_save(state: tauri::State<'_, AppState>, id: i64, book: book::Book) -> Result<book::Book, String> {
    state.with(|c| c.book_save(id, &book))
}

#[tauri::command]
fn book_delete(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    state.with(|c| c.book_delete(id))
}

/// Make the book a PDF in `destination`, named after the book. An existing file is never overwritten: a number is added.
#[tauri::command]
async fn book_export_pdf(app: tauri::AppHandle, state: tauri::State<'_, AppState>, id: i64, destination: String) -> Result<BookPdfOut, String> {
    let dest = PathBuf::from(&destination);
    if !dest.is_dir() {
        return Err("Pick a destination folder that exists.".into());
    }
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let b = st.with(|c| c.book_get(id))?;
        let stem: String = b.name.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
        let stem = export::folder_name(&stem).unwrap_or_else(|_| "Book".into());
        let load = |pid: i64, edge: u32| -> Result<image::RgbImage, String> {
            let (path, recipe) = st.with(|c| Ok((c.photo_path(pid)?, c.develop_recipe(pid)?)))?;
            let img = media::edited_picture(&path, edge, recipe.as_ref())?.to_rgb8();
            Ok(book::shrink(img, edge))
        };
        let (bytes, res) = book::render_pdf(&b, &load, &|done, total| {
            let _ = app.emit("book:progress", Progress { done, total });
        })?;
        let mut file = dest.join(format!("{stem}.pdf"));
        let mut n = 2;
        while file.exists() {
            file = dest.join(format!("{stem} ({n}).pdf"));
            n += 1;
        }
        std::fs::write(&file, bytes).map_err(|e| format!("The PDF could not be saved: {e}"))?;
        Ok(BookPdfOut { file: file.to_string_lossy().into_owned(), pages: res.pages, warnings: res.warnings })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct BookPdfOut {
    file: String,
    pages: usize,
    warnings: Vec<String>,
}

#[tauri::command]
fn catalog_info(state: tauri::State<'_, AppState>) -> Result<CatalogInfo, String> {
    let name = state.registry.lock().map_err(|_| "busy".to_string())?.current_entry().map(|e| e.name.clone()).unwrap_or_else(|| "Catalog".into());
    state.with(|c| Ok(CatalogInfo { path: c.root.to_string_lossy().into_owned(), count: c.count()?, name }))
}

/// What the open catalog holds and the room it takes.
#[tauri::command]
fn catalog_details(state: tauri::State<'_, AppState>) -> Result<catalog::CatalogDetails, String> {
    state.with(|c| c.details())
}

// ---- smart collections

#[tauri::command]
fn smart_create(state: tauri::State<'_, AppState>, name: String, rules: smart::SmartRules) -> Result<i64, String> {
    state.with(|c| c.smart_create(&name, &rules))
}

#[tauri::command]
fn smart_update(state: tauri::State<'_, AppState>, id: i64, name: String, rules: smart::SmartRules) -> Result<(), String> {
    state.with(|c| c.smart_update(id, &name, &rules))
}

#[tauri::command]
fn smart_rules(state: tauri::State<'_, AppState>, id: i64) -> Result<smart::SmartRules, String> {
    state.with(|c| c.smart_rules_of(id).ok_or_else(|| "That is not a smart collection.".to_string()))
}

/// How many photos meet these rules now (also checks the rules, so a mistake is said in words).
#[tauri::command]
fn smart_count(state: tauri::State<'_, AppState>, rules: smart::SmartRules) -> Result<i64, String> {
    state.with(|c| c.smart_count(&rules))
}

// ---- virtual copies

/// Make a virtual copy of each of these photos; returns the new copies' numbers.
#[tauri::command]
fn photo_virtual_copy(state: tauri::State<'_, AppState>, ids: Vec<i64>) -> Result<Vec<i64>, String> {
    state.with(|c| c.virtual_copies(&ids)).map(|m| m.into_iter().map(|(_, new)| new).collect())
}

// ---- looking after the catalog

#[tauri::command]
async fn catalog_check(state: tauri::State<'_, AppState>) -> Result<catalog::IntegrityReport, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || st.with(|c| c.integrity())).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupOut {
    folder: String,
    bytes: u64,
    when: String,
}

/// Back the open catalog up into a new folder inside `destination`, named after the catalog and the time.
#[tauri::command]
async fn catalog_backup(state: tauri::State<'_, AppState>, destination: String) -> Result<BackupOut, String> {
    let dest = PathBuf::from(&destination);
    if !dest.is_dir() {
        return Err("Pick a destination folder that exists.".into());
    }
    let name = state.registry.lock().map_err(|_| "busy".to_string())?.current_entry().map(|e| e.name.clone()).unwrap_or_else(|| "Catalog".into());
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let stamp = chrono::Local::now().format("%Y-%m-%d %H%M%S").to_string();
        let clean: String = name.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
        let stem = export::folder_name(&format!("{clean} backup {stamp}")).unwrap_or_else(|_| format!("Catalog backup {stamp}"));
        let mut folder = dest.join(&stem);
        let mut n = 2;
        while folder.exists() {
            folder = dest.join(format!("{stem} ({n})"));
            n += 1;
        }
        let bytes = st.with(|c| c.backup_to(&folder))?;
        let when = st.with(|c| Ok(c.last_backup().unwrap_or_default()))?;
        Ok(BackupOut { folder: folder.to_string_lossy().into_owned(), bytes, when })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoBackupState {
    settings: backups::Settings,
    backups: Vec<backups::Backup>,
    folder: String,
}

fn auto_backup_state(root: &Path) -> AutoBackupState {
    AutoBackupState { settings: backups::settings(root), backups: backups::list(root), folder: path_text(&backups::dir_of(root)) }
}

fn path_text(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn open_root(state: &AppState) -> Result<PathBuf, String> {
    state.with(|c| Ok(c.root.clone()))
}

/// The automatic backups of the open catalog and how they are set.
#[tauri::command]
async fn backup_auto_state(state: tauri::State<'_, AppState>) -> Result<AutoBackupState, String> {
    let root = open_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || Ok(auto_backup_state(&root))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn backup_auto_settings_set(state: tauri::State<'_, AppState>, on: bool, every_days: i64, keep: i64) -> Result<AutoBackupState, String> {
    let root = open_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        backups::set_settings(&root, &backups::Settings { on, every_days, keep })?;
        Ok(auto_backup_state(&root))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Make a backup now, whatever the schedule says.
#[tauri::command]
async fn backup_auto_now(state: tauri::State<'_, AppState>) -> Result<AutoBackupState, String> {
    let root = open_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        backups::write(&root, "auto")?;
        Ok(auto_backup_state(&root))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Put an automatic backup in place of the open catalog. The catalog as it is now is copied first, so a restore can be undone
/// from the same list.
#[tauri::command]
async fn backup_restore(state: tauri::State<'_, AppState>, file: String) -> Result<AutoBackupState, String> {
    let root = open_root(&state)?;
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        backups::check_file(Path::new(&file))?;
        backups::write(&root, "before-restore")?;
        drop(st.cat.lock().map_err(|_| "busy".to_string())?.take());
        let outcome = backups::restore(&root, Path::new(&file));
        activate(&st, &root)?; // open again, whether or not the restore worked
        outcome?;
        Ok(auto_backup_state(&root))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn licence_path(state: &AppState) -> PathBuf {
    file_parent_of(state).join("licence.json")
}

fn licence_status_now(state: &AppState) -> licence::Status {
    let f = licence::load(&licence_path(state), chrono::Local::now().date_naive());
    let s = licence::status_for(&f, chrono::Local::now().date_naive(), &licence::PUBLIC_KEY, env!("CARGO_PKG_VERSION"));
    licence::apply(&s);
    s
}

/// Where the licence stands: licensed, in the 30 day trial (with the days left), or expired.
#[tauri::command]
fn licence_status(state: tauri::State<'_, AppState>) -> licence::Status {
    licence_status_now(&state)
}

/// Check a key and keep it if it is good.
#[tauri::command]
fn licence_enter(state: tauri::State<'_, AppState>, key: String) -> Result<licence::Status, String> {
    let p = licence::verify_with(&licence::PUBLIC_KEY, &key)?;
    if !licence::edition_ok(&p.edition, env!("CARGO_PKG_VERSION")) {
        return Err(format!("This key is for version {} and earlier, so it does not work in this version.", p.edition));
    }
    let path = licence_path(&state);
    let mut f = licence::load(&path, chrono::Local::now().date_naive());
    f.key = Some(key.trim().to_string());
    licence::save(&path, &f);
    Ok(licence_status_now(&state))
}

/// Compact the open catalog.
#[tauri::command]
async fn catalog_optimize(state: tauri::State<'_, AppState>) -> Result<catalog::OptimizeReport, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || st.with(|c| c.optimize())).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Space {
    free: u64,
    total: u64,
}

/// How much room is left on the disk that holds this folder, or nothing when that cannot be found out.
#[tauri::command]
fn volume_space(path: String) -> Option<Space> {
    free_space(Path::new(&path)).map(|(free, total)| Space { free, total })
}

#[cfg(windows)]
fn free_space(p: &Path) -> Option<(u64, u64)> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let (mut free, mut total, mut any) = (0u64, 0u64, 0u64);
    // SAFETY: `wide` ends in a zero and the three numbers are valid places to write to
    let ok = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, &mut any) };
    (ok != 0).then_some((free, total))
}

#[cfg(not(windows))]
fn free_space(_: &Path) -> Option<(u64, u64)> {
    None
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PerfState {
    /// 0 is automatic
    threads: usize,
    cores: usize,
    /// what automatic means on this computer
    automatic: usize,
}

fn perf_state() -> PerfState {
    PerfState { threads: perf::limit(), cores: perf::cores(), automatic: perf::threads(false) }
}

/// How many worker threads heavy work may use (0 = the program decides), and how many the computer has.
#[tauri::command]
fn perf_get() -> PerfState {
    perf_state()
}

/// Set the limit on worker threads: 0 for automatic, otherwise a number up to 32.
#[tauri::command]
fn perf_set(threads: usize) -> PerfState {
    perf::set(threads);
    perf_state()
}

/// Open a photo's file in another program: the one named, or (when none is named) whatever Windows opens that kind of file with.
#[tauri::command]
fn open_in_editor(path: String, editor: Option<String>) -> Result<(), String> {
    let file = Path::new(&path);
    if !file.is_file() {
        return Err(format!("The file is not there: {path}"));
    }
    let mut cmd = match editor.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        Some(e) => {
            if !Path::new(e).is_file() {
                return Err(format!("The editing program is not there: {e}. Choose it again in Preferences."));
            }
            std::process::Command::new(e)
        }
        None => std::process::Command::new("explorer"),
    };
    cmd.arg(file).spawn().map(|_| ()).map_err(|e| format!("The program could not be started: {e}"))
}

/// Look for the files of every photo; mark the missing ones and say where they were.
#[tauri::command]
async fn missing_scan(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<catalog::MissingReport, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        st.with(|c| {
            c.scan_missing(|done, total| {
                let _ = app.emit("missing:progress", Progress { done, total });
            })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How many of a folder's photos are at `new_folder` (the folder moved there as it was). Changes nothing.
#[tauri::command]
fn relink_preview(state: tauri::State<'_, AppState>, root_id: i64, new_folder: String) -> Result<catalog::Relocation, String> {
    state.with(|c| c.relocation_preview(root_id, Path::new(&new_folder)))
}

/// Point a folder of the catalog at its new place, then look again. Files are not moved or copied.
#[tauri::command]
async fn relink_root(app: tauri::AppHandle, state: tauri::State<'_, AppState>, root_id: i64, new_folder: String) -> Result<catalog::MissingReport, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        st.with(|c| c.relocate_root(root_id, Path::new(&new_folder)))?;
        st.with(|c| {
            c.scan_missing(|done, total| {
                let _ = app.emit("missing:progress", Progress { done, total });
            })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RelinkOut {
    outcome: catalog::SearchOutcome,
    report: catalog::MissingReport,
}

/// Look through a folder for the missing photos' files (by name and size) and point the photos at what is found.
#[tauri::command]
async fn relink_search(app: tauri::AppHandle, state: tauri::State<'_, AppState>, folder: String) -> Result<RelinkOut, String> {
    let dir = PathBuf::from(&folder);
    if !dir.is_dir() {
        return Err("Pick a folder that exists.".into());
    }
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = st.with(|c| c.relink_by_search(&dir, |seen| {
            let _ = app.emit("missing:progress", Progress { done: seen, total: 0 });
        }))?;
        let report = st.with(|c| c.scan_missing(|_, _| {}))?;
        Ok(RelinkOut { outcome, report })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- the previews kept on disk

#[derive(serde::Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CacheInfo {
    /// preview files and the space they take
    files: usize,
    bytes: u64,
    /// the untouched previews (thumbnail and standard) and the ones that show the edits
    base_bytes: u64,
    edited_bytes: u64,
    photos: usize,
    /// photos with no preview to show (they are made again when asked for)
    without_preview: usize,
    /// edited photos whose edited preview is not there
    edited_without: usize,
}

fn cache_info_of(st: &AppState) -> Result<CacheInfo, String> {
    let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
    let mut info = CacheInfo::default();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !media::PREVIEW_LEVELS.iter().any(|l| name.ends_with(&format!("_{l}.jpg"))) {
                continue;
            }
            let len = e.metadata().map(|m| m.len()).unwrap_or(0);
            info.files += 1;
            info.bytes += len;
            if name.ends_with("_ethumb.jpg") || name.ends_with("_estandard.jpg") {
                info.edited_bytes += len;
            } else {
                info.base_bytes += len;
            }
        }
    }
    let items = st.with(|c| c.preview_items())?;
    info.photos = items.len();
    for (id, _, recipe) in &items {
        if !media::preview_path(&dir, *id, "standard").is_file() || !media::preview_path(&dir, *id, "thumb").is_file() {
            info.without_preview += 1;
        }
        if recipe.is_some() && (!media::preview_path(&dir, *id, "estandard").is_file() || !media::preview_path(&dir, *id, "ethumb").is_file()) {
            info.edited_without += 1;
        }
    }
    Ok(info)
}

/// Make one photo's previews: the base ones when asked for, and the edited ones when it has edits.
fn rebuild_one(dir: &Path, id: i64, src: &Path, recipe: Option<&Recipe>, base: bool) -> Result<(), String> {
    if base {
        media::build_previews(src, dir, id)?;
    }
    if let Some(r) = recipe {
        let (s, t) = media::render_edited_previews(dir, id, &r.sanitized())?;
        media::write_edited_previews(dir, id, &s, &t)?;
    }
    Ok(())
}

/// Delete preview files: only the edited ones (they are drawn again from the base ones), or all of them.
fn clear_previews(dir: &Path, all: bool) -> usize {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let edited = name.ends_with("_ethumb.jpg") || name.ends_with("_estandard.jpg");
            let base = name.ends_with("_thumb.jpg") || name.ends_with("_standard.jpg");
            if (edited || (all && base)) && std::fs::remove_file(e.path()).is_ok() {
                n += 1;
            }
        }
    }
    n
}

/// Keep the preview folder within limits: files older than `max_age_days` (0 = no age limit) go, and then the oldest files go until the
/// rest fit in `max_bytes` (0 = no size limit). A preview that is gone is made again when it is asked for, so this is always safe.
/// Returns how many files were deleted and how many bytes that freed.
fn trim_previews(dir: &Path, max_bytes: u64, max_age_days: u32) -> (usize, u64) {
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !media::PREVIEW_LEVELS.iter().any(|l| name.ends_with(&format!("_{l}.jpg"))) {
                continue;
            }
            if let Ok(m) = e.metadata() {
                files.push((m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len(), e.path()));
            }
        }
    }
    files.sort_by_key(|(when, _, _)| *when); // the oldest first
    let (mut removed, mut freed) = (0usize, 0u64);
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    let cutoff = (max_age_days > 0).then(|| std::time::SystemTime::now() - std::time::Duration::from_secs(max_age_days as u64 * 86_400));
    for (when, len, path) in files {
        let too_old = cutoff.map(|c| when < c).unwrap_or(false);
        let too_big = max_bytes > 0 && total > max_bytes;
        if !(too_old || too_big) {
            break; // sorted oldest first: nothing after this one is older or needed to make room
        }
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
            freed += len;
            total = total.saturating_sub(len);
        }
    }
    (removed, freed)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TrimOut {
    removed: usize,
    freed: u64,
}

/// Apply the preview limits chosen in Preferences (0 means no limit).
#[tauri::command]
async fn cache_trim(state: tauri::State<'_, AppState>, max_bytes: u64, max_age_days: u32) -> Result<TrimOut, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
        let (removed, freed) = trim_previews(&dir, max_bytes, max_age_days);
        Ok(TrimOut { removed, freed })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Which photos need which previews made: (id, file, edits to draw, base previews needed). With `only_missing`, just what is not
/// there; otherwise everything.
fn rebuild_plan(dir: &Path, items: Vec<(i64, PathBuf, Option<Recipe>)>, only_missing: bool) -> Vec<(i64, PathBuf, Option<Recipe>, bool)> {
    items
        .into_iter()
        .filter_map(|(id, path, recipe)| {
            let base = !only_missing || !media::preview_path(dir, id, "standard").is_file() || !media::preview_path(dir, id, "thumb").is_file();
            let edited = recipe.is_some() && (!only_missing || base || !media::preview_path(dir, id, "estandard").is_file() || !media::preview_path(dir, id, "ethumb").is_file());
            (base || edited).then_some((id, path, recipe.filter(|_| edited), base))
        })
        .collect()
}

/// Make the previews that are not there (`only_missing`) or every preview again, in the background, telling the window as they
/// are ready (the same events an import gives). Returns how many photos are being worked on.
fn spawn_rebuild(app: tauri::AppHandle, st: AppState, only_missing: bool) -> Result<usize, String> {
    let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
    let items = rebuild_plan(&dir, st.with(|c| c.preview_items())?, only_missing);
    let total = items.len();
    if total == 0 {
        return Ok(0);
    }
    let n = perf::threads(true);
    let items = Arc::new(items);
    let next = Arc::new(AtomicUsize::new(0));
    let done = Arc::new(AtomicUsize::new(0));
    for _ in 0..n {
        let (app, dir, items, next, done) = (app.clone(), dir.clone(), items.clone(), next.clone(), done.clone());
        std::thread::spawn(move || {
            let mut ready: Vec<i64> = vec![];
            loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= items.len() {
                    break;
                }
                let (id, path, recipe, base) = &items[i];
                if rebuild_one(&dir, *id, path, recipe.as_ref(), *base).is_ok() {
                    ready.push(*id);
                }
                let d = done.fetch_add(1, Ordering::SeqCst) + 1;
                if ready.len() >= 8 || d == items.len() {
                    let _ = app.emit("preview:ready", std::mem::take(&mut ready));
                    let _ = app.emit("preview:progress", Progress { done: d, total: items.len() });
                }
            }
            if !ready.is_empty() {
                let _ = app.emit("preview:ready", ready);
            }
        });
    }
    Ok(total)
}

#[tauri::command]
async fn cache_info(state: tauri::State<'_, AppState>) -> Result<CacheInfo, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cache_info_of(&st)).await.map_err(|e| e.to_string())?
}

/// Make the missing previews again ("missing") or all of them ("all"); returns how many photos are being worked on.
#[tauri::command]
fn cache_rebuild(app: tauri::AppHandle, state: tauri::State<'_, AppState>, which: String) -> Result<usize, String> {
    match which.as_str() {
        "missing" => spawn_rebuild(app, state.inner().clone(), true),
        "all" => spawn_rebuild(app, state.inner().clone(), false),
        _ => Err("Unknown choice.".into()),
    }
}

/// Free the space: delete the edited previews ("edited") or every preview ("all"). A deleted preview is made again when it is
/// asked for, and "Make missing previews" does them all.
#[tauri::command]
async fn cache_clear(state: tauri::State<'_, AppState>, which: String) -> Result<CacheInfo, String> {
    let all = match which.as_str() {
        "edited" => false,
        "all" => true,
        _ => return Err("Unknown choice.".into()),
    };
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
        clear_previews(&dir, all);
        cache_info_of(&st)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- sidecar files (XMP)

#[derive(serde::Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
struct XmpWriteOut {
    written: usize,
    /// the sidecar was already exactly what it would be
    unchanged: usize,
    /// a sidecar from another program (or one that cannot be read) is there, so it was left alone: its file name
    left_alone: Vec<String>,
    /// the original file is not there
    missing: usize,
    failed: Vec<String>,
}

/// Write the sidecars of these photos. A sidecar this app did not write is never replaced.
fn xmp_write(st: &AppState, ids: &[i64], progress: &(dyn Fn(usize, usize) + Sync)) -> Result<XmpWriteOut, String> {
    let mut out = XmpWriteOut::default();
    let total = ids.len();
    for (i, id) in ids.iter().enumerate() {
        if i % 20 == 0 {
            progress(i, total);
        }
        // a virtual copy shares its photo's file, so it has no sidecar of its own: what it holds stays in the catalog
        if st.with(|c| Ok(c.is_virtual_copy(*id))).unwrap_or(false) {
            continue;
        }
        let Ok((photo, raw, mut sc)) = st.with(|c| Ok((c.photo_path(*id)?, c.is_raw(*id)?, c.sidecar_data(*id)?))) else { continue };
        let name = photo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if !photo.is_file() {
            out.missing += 1;
            continue;
        }
        sc.ours = true;
        let text = xmp::write(&sc);
        let target = xmp::sidecar_path(&photo, raw);
        let target_name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if target.exists() {
            let existing = std::fs::metadata(&target).ok().filter(|m| m.len() <= xmp::MAX_BYTES).and_then(|_| std::fs::read_to_string(&target).ok());
            match existing {
                Some(t) if xmp::parse(&t).map(|s| s.ours).unwrap_or(false) => {
                    if t == text {
                        out.unchanged += 1;
                        let _ = st.with(|c| c.clear_changed(&[*id]));
                        continue;
                    }
                }
                _ => {
                    out.left_alone.push(target_name);
                    let _ = st.with(|c| c.clear_changed(&[*id]));
                    continue;
                }
            }
        }
        let tmp = target.with_extension("xmp.tmp");
        let result = std::fs::write(&tmp, text.as_bytes()).and_then(|_| std::fs::rename(&tmp, &target));
        match result {
            Ok(()) => {
                out.written += 1;
                let _ = st.with(|c| c.clear_changed(&[*id]));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                out.failed.push(format!("{name}: {e}"));
            }
        }
    }
    progress(total, total);
    Ok(out)
}

#[derive(serde::Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
struct XmpReadOut {
    /// photos that have a sidecar
    found: usize,
    /// of those, how many differ from the catalog
    differ: usize,
    /// how many were changed (0 unless asked to apply)
    applied: usize,
    /// per kind of difference, how many photos
    kinds: std::collections::BTreeMap<String, usize>,
    unreadable: Vec<String>,
}

/// Read the sidecars of these photos; with `apply`, make the catalog agree with them (adding keywords and edits, never removing).
fn xmp_read(st: &AppState, ids: &[i64], apply: bool, progress: &(dyn Fn(usize, usize) + Sync)) -> Result<XmpReadOut, String> {
    let mut out = XmpReadOut::default();
    let total = ids.len();
    for (i, id) in ids.iter().enumerate() {
        if i % 20 == 0 {
            progress(i, total);
        }
        if st.with(|c| Ok(c.is_virtual_copy(*id))).unwrap_or(false) {
            continue;
        }
        let Ok((photo, raw)) = st.with(|c| Ok((c.photo_path(*id)?, c.is_raw(*id)?))) else { continue };
        let target = xmp::sidecar_path(&photo, raw);
        if !target.is_file() {
            continue;
        }
        out.found += 1;
        let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let text = match std::fs::metadata(&target) {
            Ok(m) if m.len() <= xmp::MAX_BYTES => std::fs::read_to_string(&target).map_err(|e| e.to_string()),
            Ok(_) => Err("it is too big to be a sidecar".to_string()),
            Err(e) => Err(e.to_string()),
        };
        let sc = match text.and_then(|t| xmp::parse(&t)) {
            Ok(s) => s,
            Err(e) => {
                out.unreadable.push(format!("{name}: {e}"));
                continue;
            }
        };
        let diffs = if apply { st.with(|c| c.apply_sidecar(*id, &sc))? } else { st.with(|c| c.sidecar_differences(*id, &sc))? };
        if !diffs.is_empty() {
            out.differ += 1;
            for d in &diffs {
                *out.kinds.entry((*d).to_string()).or_default() += 1;
            }
            if apply {
                out.applied += 1;
                // the sidecar is what the catalog now holds
                let _ = st.with(|c| c.clear_changed(&[*id]));
            }
        }
    }
    progress(total, total);
    Ok(out)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct XmpStatus {
    auto: bool,
    /// photos whose sidecar is out of date
    changed: i64,
    last_error: Option<String>,
}

fn xmp_ids(st: &AppState, scope: &str, ids: Vec<i64>) -> Result<Vec<i64>, String> {
    match scope {
        "changed" => st.with(|c| c.changed_photo_ids(200_000)),
        "all" => st.with(|c| c.master_photo_ids()),
        "selected" => {
            if ids.len() > 200_000 {
                return Err("That is too many photos at once.".into());
            }
            Ok(ids)
        }
        _ => Err("Unknown choice of photos.".into()),
    }
}

#[tauri::command]
fn xmp_status(state: tauri::State<'_, AppState>) -> Result<XmpStatus, String> {
    let last_error = state.xmp_error.lock().map_err(|_| "busy".to_string())?.clone();
    state.with(|c| Ok(XmpStatus { auto: c.xmp_auto(), changed: c.changed_photo_count(), last_error }))
}

#[tauri::command]
fn xmp_set_auto(state: tauri::State<'_, AppState>, on: bool) -> Result<XmpStatus, String> {
    state.with(|c| c.set_xmp_auto(on))?;
    if let Ok(mut e) = state.xmp_error.lock() {
        *e = None;
    }
    xmp_status(state)
}

/// Write sidecars for the changed photos, all photos, or the selected ones.
#[tauri::command]
async fn xmp_write_now(app: tauri::AppHandle, state: tauri::State<'_, AppState>, scope: String, ids: Vec<i64>) -> Result<XmpWriteOut, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ids = xmp_ids(&st, &scope, ids)?;
        xmp_write(&st, &ids, &|done, total| {
            let _ = app.emit("xmp:progress", Progress { done, total });
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Look at the sidecars (apply = false), or make the catalog agree with them (apply = true).
#[tauri::command]
async fn xmp_read_now(app: tauri::AppHandle, state: tauri::State<'_, AppState>, scope: String, ids: Vec<i64>, apply: bool) -> Result<XmpReadOut, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ids = match scope.as_str() {
            "changed" => return Err("Choose all photos or the selected ones.".to_string()),
            s => xmp_ids(&st, s, ids)?,
        };
        let out = xmp_read(&st, &ids, apply, &|done, total| {
            let _ = app.emit("xmp:progress", Progress { done, total });
        })?;
        if apply && out.applied > 0 {
            let _ = app.emit("catalog:changed", ids);
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MergeOut {
    /// the new photo, added to the catalog next to the first of the shots
    id: i64,
    path: String,
    shots: usize,
}

/// Open the photos, make one picture of them with `make`, save it as a JPEG beside the first photo (named `<name>-<suffix>`), add it to
/// the catalog and say how far it has got (`merge:progress`).
async fn merge_photos(app: tauri::AppHandle, st: AppState, ids: Vec<i64>, suffix: &'static str, ext: &'static str, make: impl FnOnce(Vec<image::RgbImage>) -> Result<image::RgbImage, String> + Send + 'static) -> Result<MergeOut, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<MergeOut, String> {
        let paths: Vec<PathBuf> = st.with(|c| ids.iter().map(|id| c.photo_path(*id)).collect::<Result<Vec<_>, _>>())?;
        let mut shots = Vec::new();
        for (i, p) in paths.iter().enumerate() {
            let _ = app.emit("merge:progress", Progress { done: i, total: paths.len() + 1 });
            if !p.is_file() {
                return Err(format!("{} is not there (is the drive connected?).", p.file_name().and_then(|n| n.to_str()).unwrap_or("A photo")));
            }
            shots.push(media::decode_any(p, false)?.to_rgb8());
        }
        let _ = app.emit("merge:progress", Progress { done: paths.len(), total: paths.len() + 1 });
        let made = make(shots)?;
        let first = &paths[0];
        let folder = first.parent().map(Path::to_path_buf).unwrap_or_default();
        let stem = first.file_stem().and_then(|s| s.to_str()).unwrap_or("photo");
        let target = media::unique_path(&folder, &format!("{stem}-{suffix}"), ext);
        if ext == "jpg" {
            media::save_jpeg(&image::DynamicImage::ImageRgb8(made), &target, 95)?;
        } else {
            made.save(&target).map_err(|e| e.to_string())?;
        }
        let root = st.with(|c| c.photo_root(ids[0]))?;
        let summary = st.with(|c| c.import_files(std::slice::from_ref(&target), &root, "add", None, |_, _| {}))?;
        let added = summary.added.first().cloned().ok_or_else(|| summary.failed.first().cloned().unwrap_or_else(|| "The merged picture could not be added to the catalog.".into()))?;
        let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
        let _ = app.emit("merge:progress", Progress { done: paths.len() + 1, total: paths.len() + 1 });
        spawn_preview_workers(app, dir, vec![added.clone()]);
        Ok(MergeOut { id: added.0, path: added.1, shots: paths.len() })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Merge photos of one scene at different exposures into one (exposure fusion). The result is a JPEG beside the first photo, added to the
/// catalog. The photos' edits are not used: the merge starts from the files.
#[tauri::command]
async fn photo_merge_hdr(app: tauri::AppHandle, state: tauri::State<'_, AppState>, ids: Vec<i64>, align: bool) -> Result<MergeOut, String> {
    if ids.len() < 2 {
        return Err("Choose two or more photos of the same scene to merge.".into());
    }
    if ids.len() > 9 {
        return Err("Merge up to 9 photos at a time.".into());
    }
    merge_photos(app, state.inner().clone(), ids, "HDR", "jpg", move |shots| merge::fuse(&merge::within_budget(shots), align)).await
}

/// AI denoise: a denoised copy of the photo is made as a new picture beside it (a JPEG called `<name>-Denoise`) and added to the catalog.
/// `iso` tells the model how noisy the photo is; without it the photo's own ISO is used. `amount` is 0 to 100.
#[tauri::command]
async fn photo_ai_denoise(app: tauri::AppHandle, state: tauri::State<'_, AppState>, id: i64, amount: f32, iso: Option<f32>) -> Result<MergeOut, String> {
    let st = state.inner().clone();
    let iso = match iso {
        Some(i) => i,
        None => st.with(|c| Ok(c.photo_iso(id)?)).unwrap_or(None).map(|i| i as f32).unwrap_or(800.0),
    };
    let app2 = app.clone();
    merge_photos(app, st, vec![id], "Denoise", "jpg", move |mut shots| {
        let img = shots.pop().ok_or_else(|| "The photo could not be read.".to_string())?;
        denoise::denoise(&img, iso, amount / 100.0, &|done, total| {
            let _ = app2.emit("merge:progress", Progress { done, total });
        })
    })
    .await
}
/// Focus stacking (macro and close-up): shots at different focus distances are blended so each part is from the shot where it is sharpest.
#[tauri::command]
async fn photo_merge_focus(app: tauri::AppHandle, state: tauri::State<'_, AppState>, ids: Vec<i64>, align: bool) -> Result<MergeOut, String> {
    if ids.len() < 2 {
        return Err("Choose two or more photos of the same subject taken at different focus distances.".into());
    }
    if ids.len() > 40 {
        return Err("Stack up to 40 photos at a time.".into());
    }
    merge_photos(app, state.inner().clone(), ids, "Stack", "jpg", move |shots| merge::focus_stack(&merge::within_total(shots, 100_000_000), align)).await
}
/// An edited copy of the photo (its edits baked in, full size) as a TIFF beside it, added to the catalog, for an editing program to open.
#[tauri::command]
async fn photo_edit_copy(app: tauri::AppHandle, state: tauri::State<'_, AppState>, id: i64) -> Result<MergeOut, String> {
    let st = state.inner().clone();
    let recipe = st.with(|c| c.develop_recipe(id))?;
    merge_photos(app, st, vec![id], "Edit", "tif", move |mut shots| {
        let img = shots.pop().ok_or_else(|| "The photo could not be read.".to_string())?;
        Ok(match &recipe {
            Some(r) => develop::render(&img, r),
            None => img,
        })
    })
    .await
}
/// Join photos taken in turn, each overlapping the next, into a panorama (the simple form: shifted into place and blended, not bent).
/// The photos are taken in the order given.
#[tauri::command]
async fn photo_merge_pano(app: tauri::AppHandle, state: tauri::State<'_, AppState>, ids: Vec<i64>) -> Result<MergeOut, String> {
    if ids.len() < 2 {
        return Err("Choose two or more photos taken in turn, each overlapping the next, to make a panorama.".into());
    }
    if ids.len() > 12 {
        return Err("Merge up to 12 photos at a time.".into());
    }
    merge_photos(app, state.inner().clone(), ids, "Pano", "jpg", |shots| pano::stitch(&pano::within_budget(shots))).await
}
/// The second window (a second screen): it shows the photo the main window has open, big and plain.
#[tauri::command]
fn second_open(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(w) = app.get_webview_window("second") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(false);
    }
    tauri::WebviewWindowBuilder::new(&app, "second", tauri::WebviewUrl::App("index.html?second=1".into()))
        .title("Lucent Raw: second window")
        .inner_size(1100.0, 760.0)
        .min_inner_size(400.0, 300.0)
        .build()
        .map_err(|e| format!("The second window could not be opened: {e}"))?;
    Ok(true)
}

#[tauri::command]
fn second_close(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("second") {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecondShow {
    /// the photo to show, or none
    id: Option<i64>,
    /// its name and settings, as the main window writes them
    label: String,
    /// changes when the photo's picture does (an edit), so the picture is fetched again
    key: String,
}

/// Tell the second window which photo to show (does nothing when there is none).
#[tauri::command]
fn second_show(app: tauri::AppHandle, show: SecondShow) -> Result<(), String> {
    if app.get_webview_window("second").is_some() {
        let _ = app.emit_to("second", "second:show", show);
    }
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProofInfo {
    /// the profile's own description, or its file name
    name: String,
}

/// Choose the profile to proof with (a .icc or .icm file), with the way colours the profile cannot hold are handled; no path stops proofing.
#[tauri::command]
fn proof_set(state: tauri::State<'_, AppState>, path: Option<String>, intent: String) -> Result<Option<ProofInfo>, String> {
    let Some(path) = path.filter(|p| !p.trim().is_empty()) else {
        *state.proof.lock().map_err(|_| "busy".to_string())? = None;
        return Ok(None);
    };
    let file = Path::new(&path);
    let bytes = std::fs::read(file).map_err(|e| format!("The profile could not be read: {e}"))?;
    if bytes.len() > 20_000_000 {
        return Err("That file is too big to be a colour profile.".into());
    }
    let setup = proof::load(&bytes, &intent)?;
    let name = file.file_stem().and_then(|n| n.to_str()).unwrap_or("profile").to_string();
    *state.proof.lock().map_err(|_| "busy".to_string())? = Some(Arc::new(setup));
    Ok(Some(ProofInfo { name }))
}

/// The folder that is looked at for new photos, and what is done with them.
#[derive(Clone, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct WatchConfig {
    folder: String,
    /// "add" leaves them where they are; "move" and "copy" file them under `destination`
    mode: String,
    destination: Option<String>,
    options: Option<catalog::ImportOpts>,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct WatchStatus {
    /// whether a folder is being watched
    active: bool,
    /// photos brought in since it was switched on
    imported: usize,
    error: Option<String>,
}

/// Start or stop watching a folder (none: stop). Returns the status.
#[tauri::command]
fn watch_set(state: tauri::State<'_, AppState>, config: Option<WatchConfig>) -> Result<WatchStatus, String> {
    let mut status = WatchStatus::default();
    let mut slot = state.watch.lock().map_err(|_| "busy".to_string())?;
    match config.filter(|c| !c.folder.trim().is_empty()) {
        None => *slot = None,
        Some(c) => {
            let folder = PathBuf::from(&c.folder);
            if !folder.is_dir() {
                return Err("That folder is not there.".into());
            }
            if c.mode != "add" {
                let Some(dest) = c.destination.as_deref().filter(|d| Path::new(d).is_dir()) else {
                    return Err("Choose the folder the photos are to be filed in.".into());
                };
                if watch::is_inside(Path::new(dest), &folder) || watch::is_inside(&folder, Path::new(dest)) {
                    return Err("The watched folder and the folder the photos are filed in must be different, and neither may be inside the other.".into());
                }
            }
            let previews = state.previews.lock().map_err(|_| "busy".to_string())?.clone();
            if watch::is_inside(&folder, &previews) || previews.starts_with(&folder) {
                return Err("That folder holds the catalog's own files. Choose another.".into());
            }
            status.active = true;
            *slot = Some(c);
        }
    }
    *state.watch_status.lock().map_err(|_| "busy".to_string())? = status.clone();
    Ok(status)
}

#[tauri::command]
fn watch_status(state: tauri::State<'_, AppState>) -> Result<WatchStatus, String> {
    Ok(state.watch_status.lock().map_err(|_| "busy".to_string())?.clone())
}

/// Every few seconds, bring in what has appeared in the watched folder (a photo is taken once it has stopped changing).
fn start_watcher(app: tauri::AppHandle, st: AppState) {
    std::thread::spawn(move || {
        let mut tracker = watch::Tracker::default();
        let mut watching = String::new();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(4));
            let Some(cfg) = st.watch.lock().ok().and_then(|g| g.clone()) else {
                watching.clear();
                continue;
            };
            if watching != cfg.folder {
                tracker = watch::Tracker::default();
                watching = cfg.folder.clone();
            }
            let src = PathBuf::from(&cfg.folder);
            if !src.is_dir() {
                if let Ok(mut s) = st.watch_status.lock() {
                    s.error = Some("The watched folder is not there (is the drive connected?).".into());
                }
                continue;
            }
            let ready = tracker.ready(&Catalog::list_files(&src));
            if ready.is_empty() {
                continue;
            }
            let dest = cfg.destination.as_deref().map(PathBuf::from);
            let mode = if cfg.mode == "move" || cfg.mode == "copy" { cfg.mode.clone() } else { "add".to_string() };
            let opts = cfg.options.clone().unwrap_or_default();
            let done = st.with(|c| {
                let s = c.import_files_with(&ready, &src, &mode, dest.as_deref(), &opts, |_, _| {})?;
                Ok((s, c.previews_dir()))
            });
            tracker.finished(&ready);
            match done {
                Ok((summary, dir)) => {
                    if let Ok(mut s) = st.watch_status.lock() {
                        s.imported += summary.added.len();
                        s.error = summary.failed.first().cloned();
                    }
                    if !summary.added.is_empty() {
                        let _ = app.emit("watch:imported", summary.added.len());
                        let _ = app.emit("watch:newest", summary.added.last().map(|a| a.0));
                        spawn_preview_workers(app.clone(), dir, summary.added.clone());
                    }
                }
                Err(e) => {
                    if let Ok(mut s) = st.watch_status.lock() {
                        s.error = Some(e);
                    }
                }
            }
        }
    });
}

/// While it is switched on for the open catalog, write the sidecars of photos that changed, a few seconds after they do.
fn start_xmp_writer(st: AppState) {
    std::thread::spawn(move || loop {
        let mut pause = 4;
        let todo = st.with(|c| Ok(if c.xmp_auto() { c.changed_photo_ids(200)? } else { vec![] })).unwrap_or_default();
        if !todo.is_empty() {
            let result = xmp_write(&st, &todo, &|_, _| {});
            let note = match &result {
                Ok(o) if !o.failed.is_empty() => Some(format!("{} sidecar file(s) could not be written, for example {}", o.failed.len(), o.failed[0])),
                Err(e) => Some(e.clone()),
                _ => None,
            };
            if note.is_some() {
                pause = 60;
            }
            if let Ok(mut e) = st.xmp_error.lock() {
                *e = note;
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(pause));
    });
}

#[tauri::command]
fn catalog_last_backup(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    state.with(|c| Ok(c.last_backup()))
}

// ---- the AI connection (MCP): off until the person turns it on

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct McpSettings {
    enabled: bool,
    port: u16,
    token: String,
}

const MCP_FIRST_PORT: u16 = 47321;

fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

impl Default for McpSettings {
    fn default() -> Self {
        McpSettings { enabled: false, port: MCP_FIRST_PORT, token: new_token() }
    }
}

fn load_mcp_settings(file: &Path) -> McpSettings {
    let mut s: McpSettings = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if s.token.len() < 32 {
        s.token = new_token();
    }
    if s.port < 1024 {
        s.port = MCP_FIRST_PORT;
    }
    s
}

fn save_mcp_settings(state: &AppState) -> Result<(), String> {
    let file = state.mcp_file.lock().map_err(|_| "busy".to_string())?.clone();
    let json = serde_json::to_string_pretty(&state.mcp.lock().map_err(|_| "busy".to_string())?.settings).map_err(|e| e.to_string())?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, json).map_err(|e| format!("The AI connection settings could not be saved: {e}"))
}

/// What the window is told when the AI connection changes something.
fn file_parent_of(state: &AppState) -> PathBuf {
    let f = state.registry_file.lock().map(|f| f.clone()).unwrap_or_default();
    f.parent().map(Path::to_path_buf).unwrap_or_default()
}

/// What the window is told when the AI connection changes something.
fn make_tools(state: &AppState, app: &tauri::AppHandle) -> Arc<mcp_tools::LumoraTools> {
    let (st, app) = (state.clone(), app.clone());
    let notify_state = state.clone();
    Arc::new(mcp_tools::LumoraTools {
        state: notify_state,
        on_change: Arc::new(move |change| match change {
            mcp_tools::Change::Marks(ids) => {
                let _ = app.emit("catalog:changed", ids);
            }
            mcp_tools::Change::Edited(id, recipe) => {
                refresh_edited_previews(app.clone(), st.clone(), id, recipe.sanitized());
                let _ = app.emit("catalog:changed", vec![id]);
            }
        }),
    })
}

/// Start or stop the server to match the settings. A port that is taken moves on to the next one (up to twenty).
fn apply_mcp(state: &AppState, app: &tauri::AppHandle) -> Result<(), String> {
    let (enabled, first, token) = {
        let mut h = state.mcp.lock().map_err(|_| "busy".to_string())?;
        if let Some(old) = h.running.take() {
            old.stop();
        }
        h.error = None;
        (h.settings.enabled, h.settings.port, h.settings.token.clone())
    };
    if !enabled {
        return Ok(());
    }
    let tools = make_tools(state, app);
    let mut last = String::new();
    for port in first..first.saturating_add(20) {
        match mcp::start(port, token.clone(), tools.clone()) {
            Ok(r) => {
                let mut h = state.mcp.lock().map_err(|_| "busy".to_string())?;
                h.settings.port = r.port;
                h.running = Some(r);
                return Ok(());
            }
            Err(e) => last = e,
        }
    }
    state.mcp.lock().map_err(|_| "busy".to_string())?.error = Some(last.clone());
    Err(last)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpStatus {
    enabled: bool,
    running: bool,
    port: u16,
    url: String,
    token: String,
    /// the line to give Claude Code, with this computer's address and token in it
    command: String,
    error: Option<String>,
}

fn mcp_status_of(state: &AppState) -> Result<McpStatus, String> {
    let h = state.mcp.lock().map_err(|_| "busy".to_string())?;
    let url = format!("http://127.0.0.1:{}/mcp", h.settings.port);
    Ok(McpStatus {
        enabled: h.settings.enabled,
        running: h.running.is_some(),
        port: h.settings.port,
        command: format!("claude mcp add --transport http lucent-raw {url} --header \"Authorization: Bearer {}\"", h.settings.token),
        url,
        token: h.settings.token.clone(),
        error: h.error.clone(),
    })
}

#[tauri::command]
fn mcp_status(state: tauri::State<'_, AppState>) -> Result<McpStatus, String> {
    mcp_status_of(&state)
}

#[tauri::command]
fn mcp_set_enabled(app: tauri::AppHandle, state: tauri::State<'_, AppState>, enabled: bool) -> Result<McpStatus, String> {
    state.mcp.lock().map_err(|_| "busy".to_string())?.settings.enabled = enabled;
    let started = apply_mcp(&state, &app);
    if started.is_err() {
        // it could not start: leave it off, with the reason to show
        state.mcp.lock().map_err(|_| "busy".to_string())?.settings.enabled = false;
    }
    save_mcp_settings(&state)?;
    mcp_status_of(&state)
}

/// A new secret token. Whatever used the old one stops working at once.
#[tauri::command]
fn mcp_new_token(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<McpStatus, String> {
    state.mcp.lock().map_err(|_| "busy".to_string())?.settings.token = new_token();
    let _ = apply_mcp(&state, &app);
    save_mcp_settings(&state)?;
    mcp_status_of(&state)
}

// ---- several catalogs: the list, a new one, one that exists, switching, renaming and forgetting

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogItem {
    id: String,
    name: String,
    path: String,
    /// how many photos it holds (nothing when its folder cannot be read)
    photos: Option<i64>,
    /// its folder is where it was left
    exists: bool,
    current: bool,
}

#[derive(Debug, Serialize)]
struct CatalogList {
    current: String,
    items: Vec<CatalogItem>,
}

fn wanted_or_first(reg: &catalogs::Registry, first: &Path) -> PathBuf {
    reg.current_entry().map(|e| PathBuf::from(&e.path)).unwrap_or_else(|| first.to_path_buf())
}

fn save_registry(state: &AppState) -> Result<(), String> {
    let file = state.registry_file.lock().map_err(|_| "busy".to_string())?.clone();
    state.registry.lock().map_err(|_| "busy".to_string())?.save(&file)
}

/// Open the catalog in `dir` and make it the one the rest of the program works on. The old one is only let go of once the new
/// one has opened; everything remembered about the old one (the picture being edited, the folder being imported from) is dropped.
fn activate(state: &AppState, dir: &Path) -> Result<(), String> {
    let cat = Catalog::open(dir)?;
    let _ = cat.prune_orphan_previews();
    *state.previews.lock().map_err(|_| "busy".to_string())? = cat.previews_dir();
    *state.proxy.lock().map_err(|_| "busy".to_string())? = None;
    *state.full.lock().map_err(|_| "busy".to_string())? = None;
    state.edit_gen.lock().map_err(|_| "busy".to_string())?.clear();
    *state.import_root.lock().map_err(|_| "busy".to_string())? = None;
    *state.cat.lock().map_err(|_| "busy".to_string())? = Some(cat);
    schedule_backup(dir);
    Ok(())
}

/// Make the scheduled backup in the background if one is due. It uses its own connection, so nothing waits for it.
fn schedule_backup(root: &Path) {
    #[cfg(not(test))]
    {
        let root = root.to_path_buf();
        std::thread::spawn(move || {
            let _ = backups::run_if_due(&root);
        });
    }
    #[cfg(test)]
    let _ = root;
}

fn list_catalogs(state: &AppState) -> Result<CatalogList, String> {
    let reg = state.registry.lock().map_err(|_| "busy".to_string())?.clone();
    let open_count = state.with(|c| c.count()).ok();
    let items = reg
        .items
        .iter()
        .map(|e| {
            let dir = PathBuf::from(&e.path);
            let current = e.id == reg.current;
            let exists = catalogs::looks_like_catalog(&dir);
            let photos = if current { open_count } else { catalogs::count_photos(&dir) };
            CatalogItem { id: e.id.clone(), name: e.name.clone(), path: e.path.clone(), photos, exists, current }
        })
        .collect();
    Ok(CatalogList { current: reg.current, items })
}

fn make_current(state: &AppState, id: &str) -> Result<CatalogList, String> {
    state.registry.lock().map_err(|_| "busy".to_string())?.current = id.to_string();
    save_registry(state)?;
    list_catalogs(state)
}

fn create_catalog(state: &AppState, name: &str, location: Option<&str>) -> Result<CatalogList, String> {
    let name = catalogs::clean_name(name)?;
    let parent = match location.filter(|l| !l.trim().is_empty()) {
        Some(l) => PathBuf::from(l),
        None => state.catalogs_home.lock().map_err(|_| "busy".to_string())?.clone(),
    };
    std::fs::create_dir_all(&parent).map_err(|e| format!("The folder for the new catalog could not be made: {e}"))?;
    let dir = catalogs::unique_dir(&parent, &name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("The folder for the new catalog could not be made: {e}"))?;
    if let Err(e) = activate(state, &dir) {
        let _ = std::fs::remove_dir(&dir); // only goes if it is empty
        return Err(e);
    }
    let id = state.registry.lock().map_err(|_| "busy".to_string())?.add(&name, &dir)?;
    make_current(state, &id)
}

fn open_catalog(state: &AppState, path: &str) -> Result<CatalogList, String> {
    let dir = PathBuf::from(path);
    if !catalogs::looks_like_catalog(&dir) {
        return Err("That folder does not hold a catalog. A catalog folder has a file called catalog.db in it.".into());
    }
    activate(state, &dir)?;
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Catalog".into());
    let id = state.registry.lock().map_err(|_| "busy".to_string())?.add(&name, &dir)?;
    make_current(state, &id)
}

fn switch_catalog(state: &AppState, id: &str) -> Result<CatalogList, String> {
    let (entry, current) = {
        let reg = state.registry.lock().map_err(|_| "busy".to_string())?;
        (reg.find(id).cloned().ok_or("That catalog is not on the list.")?, reg.current.clone())
    };
    if entry.id == current {
        return list_catalogs(state);
    }
    let dir = PathBuf::from(&entry.path);
    if !catalogs::looks_like_catalog(&dir) {
        return Err(format!("The folder of \"{}\" is not there any more. It may have been moved, or its drive is not connected.", entry.name));
    }
    activate(state, &dir)?;
    make_current(state, &entry.id)
}

#[tauri::command]
fn catalog_list(state: tauri::State<'_, AppState>) -> Result<CatalogList, String> {
    list_catalogs(&state)
}

#[tauri::command]
fn catalog_create(state: tauri::State<'_, AppState>, name: String, location: Option<String>) -> Result<CatalogList, String> {
    create_catalog(&state, &name, location.as_deref())
}

#[tauri::command]
fn catalog_open(state: tauri::State<'_, AppState>, path: String) -> Result<CatalogList, String> {
    open_catalog(&state, &path)
}

#[tauri::command]
fn catalog_switch(state: tauri::State<'_, AppState>, id: String) -> Result<CatalogList, String> {
    switch_catalog(&state, &id)
}

#[tauri::command]
fn catalog_rename(state: tauri::State<'_, AppState>, id: String, name: String) -> Result<CatalogList, String> {
    state.registry.lock().map_err(|_| "busy".to_string())?.rename(&id, &name)?;
    save_registry(&state)?;
    list_catalogs(&state)
}

/// Take a catalog off the list. Its folder and photos are left exactly as they are.
#[tauri::command]
fn catalog_remove(state: tauri::State<'_, AppState>, id: String) -> Result<CatalogList, String> {
    state.registry.lock().map_err(|_| "busy".to_string())?.remove(&id)?;
    save_registry(&state)?;
    list_catalogs(&state)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceItem {
    path: String,
    name: String,
    /// The subfolder it is in, relative to the folder that was chosen; empty for the folder itself.
    folder: String,
    size: u64,
    raw: bool,
}

/// Every supported photo under a folder, for choosing which to import.
#[tauri::command]
async fn import_list(state: tauri::State<'_, AppState>, source: String) -> Result<Vec<SourceItem>, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&source);
        if !p.is_dir() {
            return Err("That folder does not exist.".to_string());
        }
        *st.import_root.lock().map_err(|_| "busy".to_string())? = std::fs::canonicalize(&p).ok();
        Ok(Catalog::list_files(&p)
            .into_iter()
            .map(|f| SourceItem {
                name: f.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string(),
                folder: f.parent().and_then(|d| d.strip_prefix(&p).ok()).map(|d| d.to_string_lossy().replace('\\', "/")).unwrap_or_default(),
                size: std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0),
                raw: media::kind_of(&f) == Some(media::Kind::Raw),
                path: f.to_string_lossy().into_owned(),
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectedFaces {
    faces: Vec<portrait::Portrait>,
    /// width over height of the (cropped) picture they were found in
    aspect: f32,
}

/// Find the faces in a photo, as portraits ready to retouch: regions only, every slider at its starting value. Left to
/// right in the picture. The search is done on the photo's preview, after the lens corrections and the crop, because
/// positions are fractions of the cropped picture.
#[tauri::command]
async fn portrait_detect(state: tauri::State<'_, AppState>, id: i64, recipe: Recipe) -> Result<DetectedFaces, String> {
    let dir = state.previews.lock().map_err(|_| "busy".to_string())?.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let r = recipe.sanitized();
        let mut img = base_preview(&st, &dir, id)?.to_rgb8();
        if !r.geometry.is_identity() {
            img = geometry::apply_geometry(&img, &r.geometry);
        }
        if r.has_crop() {
            img = develop::apply_crop(&img, &r.crop);
        }
        let mut found: Vec<portrait::Portrait> = faces::detect(&img)?.iter().map(|f| faces::to_portrait(f, img.width(), img.height())).collect();
        found.sort_by(|a, b| a.face.cx.total_cmp(&b.face.cx));
        Ok(DetectedFaces { aspect: img.width() as f32 / img.height() as f32, faces: found })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn import_scan(source: String) -> Result<ScanResult, String> {
    let p = Path::new(&source);
    if !p.is_dir() {
        return Err("That folder does not exist.".into());
    }
    let files = Catalog::list_files(p);
    let raw = files.iter().filter(|f| media::kind_of(f) == Some(media::Kind::Raw)).count();
    Ok(ScanResult { images: files.len() - raw, raw })
}

#[tauri::command]
async fn import_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    source: String,
    mode: String,
    destination: Option<String>,
    files: Option<Vec<String>>,
    options: Option<catalog::ImportOpts>,
) -> Result<ImportResult, String> {
    let st = state.inner().clone();
    let app2 = app.clone();
    let (summary, previews_dir) = tauri::async_runtime::spawn_blocking(move || {
        let src = PathBuf::from(&source);
        if !src.is_dir() {
            return Err("That folder does not exist.".to_string());
        }
        // the photos the person ticked, or the whole folder when no list was given
        let files = match &files {
            Some(chosen) => Catalog::pick_files(&src, chosen),
            None => Catalog::list_files(&src),
        };
        if files.is_empty() {
            return Err("None of the chosen photos could be found.".to_string());
        }
        let dest = destination.map(PathBuf::from);
        st.with(|c| {
            let s = c.import_files_with(&files, &src, &mode, dest.as_deref(), &options.clone().unwrap_or_default(), |done, total| {
                let _ = app2.emit("import:progress", Progress { done, total });
            })?;
            Ok((s, c.previews_dir()))
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    let unsupported = summary.added.iter().filter(|(_, p)| media::kind_of(Path::new(p)).is_none()).count();
    spawn_preview_workers(app, previews_dir, summary.added.clone());
    Ok(ImportResult {
        added: summary.added.len(),
        duplicates: summary.duplicates,
        failed: summary.failed,
        unsupported_previews: unsupported,
        left_behind: summary.left_behind,
        added_ids: summary.added.iter().map(|(id, _)| *id).collect(),
    })
}

/// Previews are built after the rows exist, on a few threads, and announced in batches.
fn spawn_preview_workers(app: tauri::AppHandle, dir: PathBuf, items: Vec<(i64, String)>) {
    if items.is_empty() {
        return;
    }
    let n = perf::threads(true);
    let items = Arc::new(items);
    let next = Arc::new(AtomicUsize::new(0));
    let done = Arc::new(AtomicUsize::new(0));
    for _ in 0..n {
        let (app, dir, items, next, done) = (app.clone(), dir.clone(), items.clone(), next.clone(), done.clone());
        std::thread::spawn(move || {
            let mut ready: Vec<i64> = vec![];
            loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= items.len() {
                    break;
                }
                let (id, path) = &items[i];
                if media::build_previews(Path::new(path), &dir, *id).is_ok() {
                    ready.push(*id);
                }
                let d = done.fetch_add(1, Ordering::SeqCst) + 1;
                if ready.len() >= 8 || d == items.len() {
                    let _ = app.emit("preview:ready", std::mem::take(&mut ready));
                    let _ = app.emit("preview:progress", Progress { done: d, total: items.len() });
                }
            }
            if !ready.is_empty() {
                let _ = app.emit("preview:ready", ready);
            }
        });
    }
}

/// The base preview of a photo (the untouched picture Develop and the tools start from). If it is not there, because previews
/// were cleared or never made, it is made now from the original.
fn base_preview(st: &AppState, dir: &Path, id: i64) -> Result<image::DynamicImage, String> {
    let path = media::preview_path(dir, id, "standard");
    if let Ok(img) = image::open(&path) {
        return Ok(img);
    }
    let src = st.with(|c| c.photo_path(id))?;
    if !src.is_file() {
        // the original is offline: the smart preview stands in for it
        if let Ok(img) = image::open(media::smart_path(dir, id)) {
            return Ok(img);
        }
    }
    media::build_previews(&src, dir, id).map_err(|e| format!("This photo has no preview, and one could not be made: {e}"))?;
    image::open(&path).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SmartInfo {
    /// photos that have a smart preview
    built: usize,
    /// photos asked about
    total: usize,
    /// bytes the smart previews take
    bytes: u64,
}

/// How many of these photos (all of them when `ids` is empty) have a smart preview.
#[tauri::command]
fn smart_info(state: tauri::State<'_, AppState>, ids: Vec<i64>) -> Result<SmartInfo, String> {
    let dir = state.previews.lock().map_err(|_| "busy".to_string())?.clone();
    let ids = if ids.is_empty() { state.with(|c| c.photo_ids(&Query::default()))? } else { ids };
    let (mut built, mut bytes) = (0, 0);
    for id in &ids {
        if let Ok(m) = std::fs::metadata(media::smart_path(&dir, *id)) {
            built += 1;
            bytes += m.len();
        }
    }
    Ok(SmartInfo { built, total: ids.len(), bytes })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SmartOut {
    made: usize,
    skipped: usize,
    failed: Vec<String>,
}

/// Make smart previews for these photos (all when `ids` is empty). Photos that have one are skipped, and so are those whose
/// original is offline. `smart:progress` tells the window how far it has got.
#[tauri::command]
async fn smart_build(app: tauri::AppHandle, state: tauri::State<'_, AppState>, ids: Vec<i64>) -> Result<SmartOut, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
        let ids = if ids.is_empty() { st.with(|c| c.photo_ids(&Query::default()))? } else { ids };
        let total = ids.len();
        let mut out = SmartOut { made: 0, skipped: 0, failed: vec![] };
        for (i, id) in ids.iter().enumerate() {
            let _ = app.emit("smart:progress", Progress { done: i, total });
            let src = st.with(|c| c.photo_path(*id))?;
            if media::smart_path(&dir, *id).is_file() || !src.is_file() {
                out.skipped += 1;
                continue;
            }
            match media::build_smart(&src, &dir, *id) {
                Ok(()) => out.made += 1,
                Err(e) => out.failed.push(format!("{}: {e}", src.file_name().and_then(|n| n.to_str()).unwrap_or("?"))),
            }
        }
        let _ = app.emit("smart:progress", Progress { done: total, total });
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn metadata_values(state: tauri::State<'_, AppState>) -> Result<catalog::MetadataValues, String> {
    state.with(|c| c.metadata_values())
}

#[tauri::command]
fn photo_query(state: tauri::State<'_, AppState>, query: Query) -> Result<Page, String> {
    state.with(|c| c.query(&query))
}

#[tauri::command]
fn folder_list(state: tauri::State<'_, AppState>) -> Result<Vec<FolderRow>, String> {
    state.with(|c| c.folders())
}

/// Rename a folder of the catalog on the disk and in the catalog.
#[tauri::command]
fn folder_rename(state: tauri::State<'_, AppState>, folder_id: i64, new_name: String) -> Result<(), String> {
    state.with(|c| c.rename_folder(folder_id, &new_name))
}

/// Move a folder into another folder of the same place (or to the top of the place when no destination is given).
#[tauri::command]
fn folder_move(state: tauri::State<'_, AppState>, folder_id: i64, destination: Option<i64>) -> Result<(), String> {
    state.with(|c| c.move_folder(folder_id, destination))
}

#[tauri::command]
fn photo_set_rating(state: tauri::State<'_, AppState>, ids: Vec<i64>, rating: i64) -> Result<(), String> {
    state.with(|c| c.set_rating(&ids, rating))
}

#[tauri::command]
fn photo_set_flag(state: tauri::State<'_, AppState>, ids: Vec<i64>, flag: i64) -> Result<(), String> {
    state.with(|c| c.set_flag(&ids, flag))
}

#[tauri::command]
fn photo_set_label(state: tauri::State<'_, AppState>, ids: Vec<i64>, label: Option<String>) -> Result<(), String> {
    state.with(|c| c.set_label(&ids, label.as_deref()))
}

#[tauri::command]
async fn export_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Vec<i64>,
    destination: String,
    settings: export::ExportSettings,
    new_folder: Option<String>,
) -> Result<ExportResult, String> {
    let mut dest = PathBuf::from(&destination);
    if !dest.is_dir() {
        return Err("Pick a destination folder that exists.".into());
    }
    if let Some(name) = new_folder.as_deref().filter(|n| !n.trim().is_empty()) {
        dest = dest.join(export::folder_name(name)?);
        std::fs::create_dir_all(&dest).map_err(|e| format!("The new folder could not be made: {e}"))?;
    }
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let paths: Vec<(i64, PathBuf, Option<Recipe>)> = st.with(|c| {
            ids.iter().map(|id| Ok((*id, c.photo_path(*id)?, c.develop_recipe(*id)?))).collect::<Result<Vec<_>, String>>()
        })?;
        // the details to write into each file, when asked for
        let packets: Vec<Option<String>> = if settings.sanitized().metadata == "none" {
            vec![None; paths.len()]
        } else {
            let level = settings.sanitized().metadata;
            st.with(|c| paths.iter().map(|(id, _, _)| Ok(export::metadata_packet(&c.sidecar_data(*id)?, &level))).collect::<Result<Vec<_>, String>>())?
        };
        let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
        let total = paths.len();
        let mut res = ExportResult { written: 0, failed: vec![], folder: dest.to_string_lossy().into_owned(), files: vec![] };
        for (i, (id, p, recipe)) in paths.iter().enumerate() {
            let _ = app.emit("export:progress", Progress { done: i, total });
            let tiles = |done: usize, total: usize| {
                let _ = app.emit("enlarge:progress", Progress { done, total });
            };
            // an offline original is replaced by its smart preview, when it has one (the picture is then at most 2560 pixels)
            let smart = media::smart_path(&dir, *id);
            let pixels = if !p.is_file() && smart.is_file() { smart } else { p.clone() };
            match export::export_photo_from(&pixels, p, &dest, recipe.as_ref(), &settings, i + 1, &tiles) {
                Ok(done) => {
                    if let Some(packet) = &packets[i] {
                        if let Err(e) = export::embed_xmp(&done, packet) {
                            res.failed.push(format!("{}: the file was written but its details could not be added: {e}", done.file_name().and_then(|n| n.to_str()).unwrap_or("?")));
                        }
                    }
                    res.written += 1;
                    res.files.push(done.to_string_lossy().into_owned());
                }
                Err(e) => res.failed.push(format!("{}: {e}", p.file_name().and_then(|n| n.to_str()).unwrap_or("?"))),
            }
        }
        let _ = app.emit("export:progress", Progress { done: total, total });
        Ok(res)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How an export would look, as a small picture (a data URL), for the Export dialog: the photo's edits, the watermark, the
/// border and the caption.
#[tauri::command]
async fn export_preview(state: tauri::State<'_, AppState>, id: i64, settings: export::ExportSettings) -> Result<String, String> {
    use base64::Engine;
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (path, recipe) = st.with(|c| Ok((c.photo_path(id)?, c.develop_recipe(id)?)))?;
        let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
        let key = format!("{id}|{}", serde_json::to_string(&recipe).unwrap_or_default());
        let load = || base_preview(&st, &dir, id).map(|i| i.to_rgb8());
        let jpeg = export::preview_cached(&key, load, &path, recipe.as_ref(), &settings, 900)?;
        Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn photo_ids(state: tauri::State<'_, AppState>, query: Query) -> Result<Vec<i64>, String> {
    state.with(|c| c.photo_ids(&query))
}

#[tauri::command]
fn photo_remove(state: tauri::State<'_, AppState>, ids: Vec<i64>) -> Result<usize, String> {
    if let Ok(mut slot) = state.proxy.lock() {
        *slot = None; // a removed photo's id can be handed out again
    }
    if let Ok(mut slot) = state.full.lock() {
        *slot = None;
    }
    state.with(|c| c.photo_remove(&ids))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct XferOut {
    photos: usize,
    skipped: usize,
    previews: usize,
    folder: String,
}

/// Put the chosen photos into a new catalog of their own, in a folder of that name inside `destination`.
#[tauri::command]
async fn catalog_export_photos(state: tauri::State<'_, AppState>, ids: Vec<i64>, destination: String, name: String, with_previews: bool) -> Result<XferOut, String> {
    let dir = PathBuf::from(&destination);
    if !dir.is_dir() {
        return Err("Pick a destination folder that exists.".into());
    }
    let folder = dir.join(export::folder_name(&name)?);
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let r = st.with(|c| xfer::export(c, &ids, &folder, with_previews))?;
        Ok(XferOut { photos: r.photos, skipped: r.skipped, previews: r.previews, folder: folder.to_string_lossy().into_owned() })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Add the photos of another catalog to this one (a backup is made first).
#[tauri::command]
async fn catalog_import_from(state: tauri::State<'_, AppState>, path: String, with_previews: bool) -> Result<XferOut, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let other = PathBuf::from(&path);
        let root = st.with(|c| Ok(c.root.clone()))?;
        if catalogs::looks_like_catalog(&other) && other.join("catalog.db") != root.join("catalog.db") {
            backups::write(&root, "before-import").map_err(|e| format!("The catalog was not changed, because a copy could not be made first. {e}"))?;
        }
        let r = st.with(|c| xfer::import(c, &other, with_previews))?;
        Ok(XferOut { photos: r.photos, skipped: r.skipped, previews: r.previews, folder: path })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Put the photos into one stack (the first is the top). Returns the stack.
#[tauri::command]
fn stack_group(state: tauri::State<'_, AppState>, ids: Vec<i64>) -> Result<i64, String> {
    state.with(|c| c.stack_group(&ids))
}

/// Stack the photos that were taken within `gap_seconds` of each other. Returns (stacks made, photos stacked).
#[tauri::command]
fn stack_auto(state: tauri::State<'_, AppState>, ids: Vec<i64>, gap_seconds: i64) -> Result<(usize, usize), String> {
    state.with(|c| c.stack_auto(&ids, gap_seconds))
}

/// Stack the photos that look alike. Returns (stacks made, photos stacked).
#[tauri::command]
async fn stack_similar(state: tauri::State<'_, AppState>, ids: Vec<i64>, max_distance: u32) -> Result<(usize, usize), String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || st.with(|c| c.stack_similar(&ids, max_distance))).await.map_err(|e| e.to_string())?
}

/// Take apart the stacks these photos are in. Returns how many stacks ended.
#[tauri::command]
fn stack_ungroup(state: tauri::State<'_, AppState>, ids: Vec<i64>) -> Result<usize, String> {
    state.with(|c| c.stack_ungroup(&ids))
}

/// Take these photos out of their stacks. Returns how many were in one.
#[tauri::command]
fn stack_remove(state: tauri::State<'_, AppState>, ids: Vec<i64>) -> Result<usize, String> {
    state.with(|c| c.stack_remove(&ids))
}

/// Open or close a stack, or (with no stack given) every stack.
#[tauri::command]
fn stack_collapse(state: tauri::State<'_, AppState>, stack_id: Option<i64>, collapsed: bool) -> Result<(), String> {
    state.with(|c| match stack_id {
        Some(s) => c.stack_set_collapsed(s, collapsed),
        None => c.stack_set_all_collapsed(collapsed),
    })
}

/// Make a photo the top of its stack.
#[tauri::command]
fn stack_make_top(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    state.with(|c| c.stack_make_top(id))
}

/// What deleting these photos from the disk would take, so the person can be told before anything is done.
#[tauri::command]
fn photo_delete_preview(state: tauri::State<'_, AppState>, ids: Vec<i64>) -> Result<Vec<String>, String> {
    state.with(|c| c.files_to_delete(&ids)).map(|v| v.iter().map(|p| p.to_string_lossy().replace('\\', "/")).collect())
}

/// Move the photos' files (and their sidecars) to the Recycle Bin, then take the photos out of the catalog. If the files cannot be
/// moved, nothing is removed from the catalog. Returns how many photos were taken out.
#[tauri::command]
fn photo_delete_from_disk(state: tauri::State<'_, AppState>, ids: Vec<i64>) -> Result<usize, String> {
    let files = state.with(|c| c.files_to_delete(&ids))?;
    if !files.is_empty() {
        trash::delete_all(&files).map_err(|e| format!("The files could not be moved to the Recycle Bin, so nothing was deleted: {e}"))?;
    }
    photo_remove(state, ids)
}

#[tauri::command]
fn collection_list(state: tauri::State<'_, AppState>) -> Result<Vec<CollectionRow>, String> {
    state.with(|c| c.collections())
}

/// The colour profile Windows uses for the main display.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DisplayProfile {
    /// the profile's own name ("sRGB IEC61966-2.1", "DELL U2723QE"), or its file name when it has none
    name: String,
    path: String,
    /// the profile is sRGB (or says nothing), so the pictures need no conversion for this screen
    is_srgb: bool,
}

/// The name an ICC profile gives itself, read from its description tag (the old text form and the newer multi-language one).
fn icc_description(bytes: &[u8]) -> Option<String> {
    let be32 = |o: usize| bytes.get(o..o + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize);
    if bytes.get(36..40)? != b"acsp" {
        return None;
    }
    let count = be32(128)?;
    for i in 0..count.min(200) {
        let e = 132 + i * 12;
        if bytes.get(e..e + 4)? != b"desc" {
            continue;
        }
        let (off, len) = (be32(e + 4)?, be32(e + 8)?);
        let tag = bytes.get(off..off.checked_add(len)?)?;
        return match tag.get(0..4)? {
            b"desc" => {
                let n = u32::from_be_bytes(tag.get(8..12)?.try_into().ok()?) as usize;
                let s = tag.get(12..12 + n)?;
                Some(String::from_utf8_lossy(s).trim_end_matches('\0').trim().to_string())
            }
            b"mluc" => {
                // the first record: length, offset, both from the start of the tag; the text is UTF-16, big endian
                let rlen = u32::from_be_bytes(tag.get(20..24)?.try_into().ok()?) as usize;
                let roff = u32::from_be_bytes(tag.get(24..28)?.try_into().ok()?) as usize;
                let s = tag.get(roff..roff + rlen)?;
                let units: Vec<u16> = s.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
                Some(String::from_utf16_lossy(&units).trim().to_string())
            }
            _ => None,
        }
        .filter(|s| !s.is_empty());
    }
    None
}

fn profile_from_file(path: &Path) -> DisplayProfile {
    let bytes = std::fs::read(path).ok().filter(|b| b.len() < 8 * 1024 * 1024).unwrap_or_default();
    let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let name = icc_description(&bytes).unwrap_or(file);
    let is_srgb = name.to_ascii_lowercase().contains("srgb");
    DisplayProfile { name, path: path.to_string_lossy().replace('\\', "/"), is_srgb }
}

#[cfg(windows)]
fn display_profile_path() -> Option<PathBuf> {
    use windows_sys::Win32::Graphics::Gdi::{GetDC, ReleaseDC};
    use windows_sys::Win32::UI::ColorSystem::GetICMProfileW;
    // SAFETY: the device context of the whole screen is asked for and given back; the buffer is as long as the length says
    unsafe {
        let dc = GetDC(std::ptr::null_mut());
        if dc.is_null() {
            return None;
        }
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = GetICMProfileW(dc, &mut len, buf.as_mut_ptr());
        ReleaseDC(std::ptr::null_mut(), dc);
        if ok == 0 {
            return None;
        }
        let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        Some(PathBuf::from(String::from_utf16_lossy(&buf[..end])))
    }
}

#[cfg(not(windows))]
fn display_profile_path() -> Option<PathBuf> {
    None
}

/// The profile of the main display, or nothing when Windows does not say.
#[tauri::command]
fn display_profile() -> Option<DisplayProfile> {
    display_profile_path().filter(|p| p.is_file()).map(|p| profile_from_file(&p))
}

/// A memory card (or other drive) that looks like it holds camera photos.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Card {
    /// the folder to import from: the card's DCIM folder when it has one, otherwise the whole drive
    path: String,
    /// "E:"
    label: String,
    removable: bool,
    has_dcim: bool,
}

/// The drives to offer as cards: removable ones, and any drive with a DCIM folder (where cameras put photos), except the system drive.
fn cards_among(roots: &[(String, bool)], system: &str) -> Vec<Card> {
    roots
        .iter()
        .filter(|(root, _)| !root.eq_ignore_ascii_case(system))
        .filter_map(|(root, removable)| {
            let dcim = Path::new(root).join("DCIM");
            let has_dcim = dcim.is_dir();
            if !*removable && !has_dcim {
                return None;
            }
            let label = root.trim_end_matches(['\\', '/']).to_string();
            let path = if has_dcim { dcim } else { PathBuf::from(root) };
            Some(Card { path: path.to_string_lossy().replace('\\', "/"), label, removable: *removable, has_dcim })
        })
        .collect()
}

#[cfg(windows)]
fn drive_roots() -> Vec<(String, bool)> {
    use std::os::windows::ffi::OsStrExt;
    // SAFETY: GetLogicalDrives takes nothing; GetDriveTypeW gets a zero-ended wide string that outlives the call
    let mask = unsafe { windows_sys::Win32::Storage::FileSystem::GetLogicalDrives() };
    (0..26u32)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| {
            let root = format!("{}:\\", (b'A' + i as u8) as char);
            let wide: Vec<u16> = std::ffi::OsStr::new(&root).encode_wide().chain(std::iter::once(0)).collect();
            let kind = unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(wide.as_ptr()) };
            (root, kind == 2) // DRIVE_REMOVABLE
        })
        .collect()
}

#[cfg(not(windows))]
fn drive_roots() -> Vec<(String, bool)> {
    Vec::new()
}

/// The memory cards plugged in now, so the import window can offer them.
#[tauri::command]
fn import_cards() -> Vec<Card> {
    let system = std::env::var("SystemDrive").map(|d| format!("{d}\\")).unwrap_or_else(|_| "C:\\".into());
    cards_among(&drive_roots(), &system)
}

/// Show a folder in the file manager (Windows Explorer).
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err(format!("The folder is not there: {path}"));
    }
    #[cfg(windows)]
    let program = "explorer";
    #[cfg(not(windows))]
    let program = "xdg-open";
    std::process::Command::new(program).arg(p).spawn().map(|_| ()).map_err(|e| format!("The folder could not be shown: {e}"))
}

/// Name a virtual copy.
#[tauri::command]
fn photo_rename_copy(state: tauri::State<'_, AppState>, id: i64, name: String) -> Result<(), String> {
    state.with(|c| c.rename_copy(id, &name))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncOut {
    imported: usize,
    duplicates: usize,
    failed: Vec<String>,
    marked_missing: usize,
    removed: usize,
}

/// What synchronising this folder would do: the files on the disk the catalog does not have, and the photos whose files are gone.
#[tauri::command]
fn folder_sync_preview(state: tauri::State<'_, AppState>, folder_id: i64) -> Result<catalog::SyncPreview, String> {
    state.with(|c| c.sync_preview(folder_id))
}

/// Bring the catalog in step with a folder on the disk: import what is new (left where it is), and either remove the photos whose files are
/// gone or mark them missing.
#[tauri::command]
async fn folder_sync_run(app: tauri::AppHandle, state: tauri::State<'_, AppState>, folder_id: i64, import_new: bool, remove_gone: bool) -> Result<SyncOut, String> {
    let st = state.inner().clone();
    let app2 = app.clone();
    let (out, previews_dir, added) = tauri::async_runtime::spawn_blocking(move || {
        st.with(|c| {
            let preview = c.sync_preview(folder_id)?;
            let (_, root_abs, _) = c.folder_parts_public(folder_id)?;
            let mut out = SyncOut { imported: 0, duplicates: 0, failed: vec![], marked_missing: 0, removed: 0 };
            let mut added = vec![];
            if import_new && !preview.new_files.is_empty() {
                let files: Vec<PathBuf> = preview.new_files.iter().map(PathBuf::from).collect();
                let s = c.import_files_with(&files, Path::new(&root_abs), "add", None, &catalog::ImportOpts::default(), |done, total| {
                    let _ = app2.emit("import:progress", Progress { done, total });
                })?;
                out.imported = s.added.len();
                out.duplicates = s.duplicates;
                out.failed = s.failed;
                added = s.added;
            }
            let ids: Vec<i64> = preview.gone.iter().map(|g| g.id).collect();
            if remove_gone {
                out.removed = c.photo_remove(&ids)?;
            } else {
                c.mark_missing(&ids)?;
                out.marked_missing = ids.len();
            }
            Ok((out, c.previews_dir(), added))
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    spawn_preview_workers(app, previews_dir, added);
    Ok(out)
}

/// Reconnect one photo to a file chosen by hand.
#[tauri::command]
fn photo_relink(state: tauri::State<'_, AppState>, id: i64, file: String) -> Result<(), String> {
    if let Ok(mut slot) = state.proxy.lock() {
        *slot = None;
    }
    state.with(|c| c.relink_photo(id, Path::new(&file)))
}

/// Synonyms, and whether a keyword goes into sidecar files, for one keyword.
#[tauri::command]
fn keyword_set_options(state: tauri::State<'_, AppState>, id: i64, synonyms: String, include_on_export: bool, is_private: bool) -> Result<(), String> {
    state.with(|c| c.keyword_set_options(id, &synonyms, include_on_export, is_private))
}

/// A collection set: a folder of collections. `parent` is another set it goes inside, or nothing for the top.
#[tauri::command]
fn collection_set_create(state: tauri::State<'_, AppState>, name: String, parent: Option<i64>) -> Result<i64, String> {
    state.with(|c| c.collection_set_create(&name, parent))
}

/// Put a collection or set inside a set (or at the top when no set is given).
#[tauri::command]
fn collection_move(state: tauri::State<'_, AppState>, id: i64, parent: Option<i64>) -> Result<(), String> {
    state.with(|c| c.collection_move(id, parent))
}

#[tauri::command]
fn collection_create(state: tauri::State<'_, AppState>, name: String) -> Result<i64, String> {
    state.with(|c| c.collection_create(&name))
}

#[tauri::command]
fn collection_rename(state: tauri::State<'_, AppState>, id: i64, name: String) -> Result<(), String> {
    state.with(|c| c.collection_rename(id, &name))
}

#[tauri::command]
fn collection_delete(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    state.with(|c| c.collection_delete(id))
}

#[tauri::command]
fn collection_add(state: tauri::State<'_, AppState>, id: i64, photo_ids: Vec<i64>) -> Result<(), String> {
    state.with(|c| c.collection_add(id, &photo_ids))
}

#[tauri::command]
fn collection_remove(state: tauri::State<'_, AppState>, id: i64, photo_ids: Vec<i64>) -> Result<(), String> {
    state.with(|c| c.collection_remove(id, &photo_ids))
}

#[tauri::command]
fn collection_set_target(state: tauri::State<'_, AppState>, id: Option<i64>) -> Result<(), String> {
    state.with(|c| c.collection_set_target(id))
}

#[tauri::command]
fn quick_toggle(state: tauri::State<'_, AppState>, photo_ids: Vec<i64>) -> Result<bool, String> {
    state.with(|c| c.quick_toggle(&photo_ids))
}

#[tauri::command]
fn keyword_list(state: tauri::State<'_, AppState>) -> Result<Vec<KeywordRow>, String> {
    state.with(|c| c.keywords())
}

#[tauri::command]
fn keyword_add(state: tauri::State<'_, AppState>, photo_ids: Vec<i64>, path: Vec<String>) -> Result<i64, String> {
    state.with(|c| c.keyword_add(&photo_ids, &path))
}

#[tauri::command]
fn keyword_remove(state: tauri::State<'_, AppState>, photo_ids: Vec<i64>, keyword_id: i64) -> Result<(), String> {
    state.with(|c| c.keyword_remove(&photo_ids, keyword_id))
}

#[tauri::command]
fn keywords_for(state: tauri::State<'_, AppState>, photo_ids: Vec<i64>) -> Result<Vec<KeywordUse>, String> {
    state.with(|c| c.keywords_for(&photo_ids))
}

#[tauri::command]
fn metadata_get(state: tauri::State<'_, AppState>, photo_ids: Vec<i64>) -> Result<MetaView, String> {
    state.with(|c| c.metadata_get(&photo_ids))
}

#[tauri::command]
fn metadata_set(state: tauri::State<'_, AppState>, photo_ids: Vec<i64>, patch: MetaPatch) -> Result<(), String> {
    state.with(|c| c.metadata_set(&photo_ids, &patch))
}

#[tauri::command]
fn develop_get(state: tauri::State<'_, AppState>, id: i64) -> Result<DevelopState, String> {
    state.with(|c| c.develop_get(id))
}

#[tauri::command]
fn develop_save(app: tauri::AppHandle, state: tauri::State<'_, AppState>, id: i64, recipe: Recipe, step: Option<StepIn>) -> Result<(), String> {
    state.with(|c| c.develop_save(id, &recipe, step.as_ref()))?;
    refresh_edited_previews(app, state.inner().clone(), id, recipe.sanitized());
    Ok(())
}

/// What "Auto" suggests for a picture: the tone and colour from its histogram, and then, when it has faces, the exposure aimed at the
/// skin, so a person in shade is not left dark because the rest of the picture is bright (and the other way round).
pub(crate) fn auto_for_picture(img: &image::RgbImage) -> develop::AutoSettings {
    let mut a = develop::auto_settings(img);
    let long = img.width().max(img.height());
    let small = if long > 1280 {
        let k = 1280.0 / long as f32;
        image::imageops::resize(img, ((img.width() as f32 * k) as u32).max(1), ((img.height() as f32 * k) as u32).max(1), image::imageops::FilterType::Triangle)
    } else {
        img.clone()
    };
    let r = Recipe { exposure: a.exposure, contrast: a.contrast, highlights: a.highlights, shadows: a.shadows, whites: a.whites, blacks: a.blacks, vibrance: a.vibrance, saturation: a.saturation, ..Recipe::default() };
    let shown = develop::render(&small, &r);
    if let Ok(found) = faces::detect(&shown) {
        if !found.is_empty() {
            let advice = advisor::advise(&shown, &found, &r);
            if let Some(e) = advice.items.iter().find(|i| i.id == "skin-light").and_then(|i| i.changes.iter().find(|c| c.field == "exposure")) {
                // a nudge towards the faces, not a jump: deep skin is not a fault to be corrected
                a.exposure = ((a.exposure + (e.value - a.exposure).clamp(-0.4, 0.4)) * 20.0).round() / 20.0;
            }
        }
    }
    a
}

/// What "Auto" suggests for a photo, worked out from its untouched preview.
#[tauri::command]
async fn develop_auto(state: tauri::State<'_, AppState>, id: i64) -> Result<develop::AutoSettings, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
        let img = base_preview(&st, &dir, id)?;
        Ok(auto_for_picture(&img.to_rgb8()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A good place to copy from for a new spot, found on the photo's untouched preview.
#[tauri::command]
async fn develop_spot_source(state: tauri::State<'_, AppState>, id: i64, x: f32, y: f32, size: f32) -> Result<(f32, f32), String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
        let img = base_preview(&st, &dir, id)?;
        Ok(spots::suggest_source(&img.to_rgb8(), x.clamp(0.0, 1.0), y.clamp(0.0, 1.0), size.clamp(0.005, 0.3)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DustOut {
    x: f32,
    y: f32,
    /// where to copy from, found like the automatic source of a spot
    sx: f32,
    sy: f32,
    size: f32,
}

/// Look for dust and sensor specks in the photo (as it is cropped and straightened by the recipe). Returns the strongest, most 50, each with
/// a source to heal it from. Nothing is changed.
#[tauri::command]
async fn develop_find_dust(state: tauri::State<'_, AppState>, id: i64, recipe: Recipe) -> Result<Vec<DustOut>, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
        let r = recipe.sanitized();
        let base = base_preview(&st, &dir, id)?.to_rgb8();
        let bent = if r.geometry.is_identity() { base } else { geometry::apply_geometry(&base, &r.geometry) };
        let framed = if r.has_crop() { develop::apply_crop(&bent, &r.crop) } else { bent };
        Ok(spots::find_dust(&framed)
            .into_iter()
            .map(|d| {
                let (sx, sy) = spots::suggest_source(&framed, d.x, d.y, d.size);
                DustOut { x: d.x, y: d.y, sx, sy, size: d.size }
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn preset_list(state: tauri::State<'_, AppState>) -> Result<Vec<PresetRow>, String> {
    state.with(|c| c.preset_list())
}

#[tauri::command]
fn preset_create(state: tauri::State<'_, AppState>, name: String, group: Option<String>, groups: Vec<String>, recipe: Recipe) -> Result<i64, String> {
    state.with(|c| c.preset_create(&name, group.as_deref(), &groups, &recipe))
}

#[tauri::command]
fn preset_rename(state: tauri::State<'_, AppState>, id: i64, name: String) -> Result<(), String> {
    state.with(|c| c.preset_rename(id, &name))
}

#[tauri::command]
fn preset_delete(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    state.with(|c| c.preset_delete(id))
}

#[tauri::command]
fn snapshot_list(state: tauri::State<'_, AppState>, photo_id: i64) -> Result<Vec<SnapshotRow>, String> {
    state.with(|c| c.snapshot_list(photo_id))
}

#[tauri::command]
fn snapshot_create(state: tauri::State<'_, AppState>, photo_id: i64, name: String, recipe: Recipe) -> Result<i64, String> {
    state.with(|c| c.snapshot_create(photo_id, &name, &recipe))
}

#[tauri::command]
fn snapshot_delete(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    state.with(|c| c.snapshot_delete(id))
}

/// Bring the Library's picture of a photo up to date with its edits, off the main thread. When two
/// saves come close together only the newest one is written, and the page is told which photo changed.
fn refresh_edited_previews(app: tauri::AppHandle, state: AppState, id: i64, recipe: Recipe) {
    let generation = match state.edit_gen.lock() {
        Ok(mut g) => {
            let n = g.entry(id).or_insert(0);
            *n += 1;
            *n
        }
        Err(_) => return,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(dir) = state.previews.lock().map(|d| d.clone()) else { return };
        let current = |state: &AppState| state.edit_gen.lock().map(|g| g.get(&id).copied() == Some(generation)).unwrap_or(false);
        if recipe == Recipe::default() {
            media::clear_edited_previews(&dir, id);
        } else {
            let Ok((std_img, thumb)) = media::render_edited_previews(&dir, id, &recipe) else { return };
            if !current(&state) {
                return; // a newer save is on its way and will write
            }
            if media::write_edited_previews(&dir, id, &std_img, &thumb).is_err() {
                return;
            }
        }
        if current(&state) {
            let _ = app.emit("preview:edited", vec![id]);
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ZoomInfo {
    /// Size of the full picture after the recipe's crop, in pixels.
    width: u32,
    height: u32,
}

/// The skin-tone assistant and the photo suggestions: measures the picture as it is drawn now (faces found in it, the colour of
/// their skin, how light it is) and says what to change.
#[tauri::command]
async fn advise_photo(state: tauri::State<'_, AppState>, id: i64, recipe: Recipe) -> Result<advisor::Advice, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || advice_for(&st, id, &recipe)).await.map_err(|e| e.to_string())?
}

/// B BOT's look at a photo as the recipe draws it.
fn advice_for(st: &AppState, id: i64, recipe: &Recipe) -> Result<advisor::Advice, String> {
    let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
    let proxy = base_preview(&st, &dir, id)?.to_rgb8();
    let shown = develop::render(&proxy, recipe);
    let faces = faces::detect(&shown)?;
    let mut advice = advisor::advise(&shown, &faces, recipe);
    advice.look = aesthetic::score(&shown).ok();
    Ok(advice)
}

#[derive(Serialize)]
struct SubjectMap {
    map: String,
}

/// The main subject of the picture as it is cropped and turned now (without any tone edits, which would only confuse it), for
/// the Subject and Background masks. The answer is a small grey picture as text, kept in the mask.
#[tauri::command]
async fn mask_subject(state: tauri::State<'_, AppState>, id: i64, recipe: Recipe) -> Result<SubjectMap, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
        let proxy = base_preview(&st, &dir, id)?.to_rgb8();
        // the framing only: the same turn, lens and crop, none of the colour work, no masks
        let framing = Recipe { geometry: recipe.geometry.clone(), crop: recipe.crop.clone(), ..Recipe::default() };
        let shown = develop::render(&proxy, &framing);
        Ok(SubjectMap { map: subject::encode(&subject::find_subject(&shown)?)? })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One part of every person in the picture (skin, hair, eyes, lips, brows, neck, teeth, clothes), for the People masks. The answer is a
/// small grey picture as text, kept in the mask, like the Subject mask.
#[tauri::command]
async fn mask_person(state: tauri::State<'_, AppState>, id: i64, recipe: Recipe, part: String) -> Result<SubjectMap, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
        let proxy = base_preview(&st, &dir, id)?.to_rgb8();
        let framing = Recipe { geometry: recipe.geometry.clone(), crop: recipe.crop.clone(), ..Recipe::default() };
        let shown = develop::render(&proxy, &framing);
        Ok(SubjectMap { map: subject::encode(&parsing::person_map(&shown, &part)?)? })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How near each part of the picture is (as it is cropped and turned now), for the Depth range mask and the Lens blur. The answer is a small
/// grey picture as text, kept in the mask: white is near, black is far.
#[tauri::command]
async fn mask_depth(state: tauri::State<'_, AppState>, id: i64, recipe: Recipe) -> Result<SubjectMap, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
        let proxy = base_preview(&st, &dir, id)?.to_rgb8();
        let framing = Recipe { geometry: recipe.geometry.clone(), crop: recipe.crop.clone(), ..Recipe::default() };
        let shown = develop::render(&proxy, &framing);
        Ok(SubjectMap { map: subject::encode(&depth::find_depth(&shown)?)? })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObjectMap {
    map: String,
    /// how sure the model is (0 to 1)
    confidence: f32,
}

/// The object under a point of the picture (as it is cropped and turned now), for the Object mask. The first time on a photo the model looks at
/// the whole picture (several seconds); after that each point is quick. The answer is a small grey picture as text, kept in the mask.
#[tauri::command]
async fn mask_object(state: tauri::State<'_, AppState>, id: i64, recipe: Recipe, x: f32, y: f32, not_x: Option<f32>, not_y: Option<f32>) -> Result<ObjectMap, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
        let proxy = base_preview(&st, &dir, id)?.to_rgb8();
        let framing = Recipe { geometry: recipe.geometry.clone(), crop: recipe.crop.clone(), ..Recipe::default() };
        let shown = develop::render(&proxy, &framing);
        let seen = object::look(&shown, &format!("{id}|{}", crop_key(&framing)))?;
        let (map, confidence) = object::pick(&seen, x, y, not_x.zip(not_y))?;
        Ok(ObjectMap { map: object::encode(&map)?, confidence })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CullRow {
    id: i64,
    name: String,
    sharpness: f32,
    blown: f32,
    crushed: f32,
    /// how good it looks to most people, 1 to 10 (about 5 is ordinary), when the model could score it
    look: Option<f32>,
    /// the sharpest part of the photo is not sharp
    soft: bool,
    /// "too bright" or "too dark"
    exposure: Option<String>,
    /// the number of the burst or near-duplicate group it is in (counting from 0), if any
    group: Option<usize>,
    /// it is the best of its group
    best: bool,
    /// why it could not be looked at
    skipped: Option<String>,
}

#[derive(Serialize)]
struct CullReport {
    rows: Vec<CullRow>,
    groups: usize,
}

/// Look at these photos' previews for culling: how sharp, how well exposed, and which are bursts or near-duplicates of each
/// other (with the best of each). It changes nothing; the page offers what to flag.
#[tauri::command]
async fn cull_scan(app: tauri::AppHandle, state: tauri::State<'_, AppState>, ids: Vec<i64>) -> Result<CullReport, String> {
    if ids.len() > 20_000 {
        return Err("That is too many photos to look at in one go (20,000 at most).".into());
    }
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        cull_report(&st, &ids, &|done, total| {
            let _ = app.emit("cull:progress", Progress { done, total });
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The cull work itself, so the window and the AI connection both use it. `progress(done, total)` is told as photos are looked at.
fn cull_report(st: &AppState, ids: &[i64], progress: &(dyn Fn(usize, usize) + Sync)) -> Result<CullReport, String> {
    let dir = st.previews.lock().map_err(|_| "busy".to_string())?.clone();
    let info = st.with(|c| c.cull_info(ids))?;
    let total = ids.len();
    let done = AtomicUsize::new(0);
    let threads = perf::threads(false).min(total.max(1));
    let measured: Vec<Option<cull::Metrics>> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..threads)
            .map(|t| {
                let (dir, done) = (&dir, &done);
                s.spawn(move || {
                    ids.iter()
                        .enumerate()
                        .skip(t)
                        .step_by(threads)
                        .map(|(i, id)| {
                            let m = base_preview(st, dir, *id).ok().map(|img| {
                                let rgb = img.to_rgb8();
                                let mut m = cull::measure(&rgb);
                                m.look = aesthetic::score(&rgb).unwrap_or(0.0);
                                m
                            });
                            progress(done.fetch_add(1, Ordering::SeqCst) + 1, total);
                            (i, m)
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let mut all: Vec<Option<cull::Metrics>> = vec![None; total];
        for h in handles {
            for (i, m) in h.join().unwrap_or_default() {
                all[i] = m;
            }
        }
        all
    });
    let items: Vec<cull::Item> = ids
        .iter()
        .zip(&measured)
        .filter_map(|(id, m)| Some(cull::Item { id: *id, taken: info.get(id).and_then(|(_, t)| t.as_deref()).and_then(cull::parse_taken), m: (*m)? }))
        .collect();
    let groups = cull::group(&items);
    let mut in_group: std::collections::HashMap<i64, (usize, bool)> = std::collections::HashMap::new();
    for (g, grp) in groups.iter().enumerate() {
        for id in &grp.ids {
            in_group.insert(*id, (g, *id == grp.best));
        }
    }
    let rows = ids
        .iter()
        .zip(&measured)
        .map(|(id, m)| {
            let name = info.get(id).map(|(n, _)| n.clone()).unwrap_or_else(|| format!("Photo {id}"));
            match m {
                Some(m) => CullRow { id: *id, name, look: (m.look > 0.0).then_some(m.look), sharpness: m.sharpness, blown: m.blown, crushed: m.crushed, soft: cull::is_soft(m), exposure: cull::exposure_problem(m).map(String::from), group: in_group.get(id).map(|g| g.0), best: in_group.get(id).map(|g| g.1).unwrap_or(false), skipped: None },
                None => CullRow { id: *id, name, look: None, sharpness: 0.0, blown: 0.0, crushed: 0.0, soft: false, exposure: None, group: None, best: false, skipped: Some("It has no preview yet.".into()) },
            }
        })
        .collect();
    Ok(CullReport { rows, groups: groups.len() })
}

/// About how big the picture is after the recipe's turn and crop, without cutting it: what the Enlarge panel shows.
#[tauri::command]
async fn enlarge_info(state: tauri::State<'_, AppState>, id: i64, recipe: Recipe) -> Result<ZoomInfo, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // a photo whose size the catalog never stored (many RAW files) is opened once to find it, and the size is kept
        let dims = match st.with(|c| c.photo_dims(id))? {
            Some(d) => d,
            None => {
                let path = st.with(|c| c.photo_path(id))?;
                let img = media::edited_picture(&path, 0, None).map_err(|e| format!("The size of this photo could not be read: {e}"))?;
                let d = (img.width(), img.height());
                let _ = st.with(|c| c.set_photo_dims(id, d.0, d.1));
                d
            }
        };
        let r = recipe.sanitized();
        let (w, h) = if r.geometry.quarter_turns % 2 == 1 { (dims.1, dims.0) } else { dims };
        let (w, h) = develop::crop_size(w, h, &r.crop);
        Ok(ZoomInfo { width: w, height: h })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnlargePreview {
    /// The middle of the picture at 100%, made four times as large by simply repeating its pixels (what an enlargement does to it without help).
    before: String,
    /// The same part, enlarged four times by the chosen method.
    after: String,
}

fn png_data_url(img: &image::RgbImage) -> Result<String, String> {
    use base64::Engine;
    let mut bytes = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// A small before-and-after of enlarging the picture as edited: the middle 120 x 80 pixels, at 100% and four times as large.
#[tauri::command]
async fn enlarge_preview(state: tauri::State<'_, AppState>, id: i64, recipe: Recipe, method: upscale::Enlarge) -> Result<EnlargePreview, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = st.with(|c| c.photo_path(id))?;
        let img = media::edited_picture(&path, 0, Some(&recipe))?.to_rgb8();
        let (rw, rh) = (120.min(img.width()), 80.min(img.height()));
        let part = image::imageops::crop_imm(&img, (img.width() - rw) / 2, (img.height() - rh) / 2, rw, rh).to_image();
        let before = image::imageops::resize(&part, rw * 4, rh * 4, image::imageops::FilterType::Nearest);
        let after = upscale::enlarge(part, rw.max(rh) * 4, method, &|_, _| {})?;
        Ok(EnlargePreview { before: png_data_url(&before)?, after: png_data_url(&after)? })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Prepare the 1:1 view: decode the full-size photo (a RAW takes a second or two) and crop it.
#[tauri::command]
async fn develop_zoom_open(state: tauri::State<'_, AppState>, id: i64, recipe: Recipe) -> Result<ZoomInfo, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let img = ensure_full(&st, id, &recipe)?;
        if std::env::var_os("PENUMBRA_TIMING").is_some() {
            eprintln!("zoom open {id}: {:?}, {}x{}", started.elapsed(), img.width(), img.height());
        }
        Ok(ZoomInfo { width: img.width(), height: img.height() })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Let go of the full-size picture (it can be over 100 MB).
#[tauri::command]
fn develop_zoom_close(state: tauri::State<'_, AppState>) {
    if let Ok(mut slot) = state.full.lock() {
        *slot = None;
    }
}

/// `thumb://localhost/render/{id}?r=<recipe json>`: the standard preview with the recipe applied.
fn serve_render(state: &AppState, id: i64, query: Option<&str>) -> tauri::http::Response<Vec<u8>> {
    let fail = |code: u16| tauri::http::Response::builder().status(code).body(Vec::new()).unwrap();
    let param = |key: &str| {
        query
            .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix(key)))
            .and_then(|v| percent_encoding::percent_decode_str(v).decode_utf8().ok().map(|c| c.into_owned()))
    };
    let recipe: Recipe = param("r=").and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
    // while a slider is being dragged the page asks for a smaller picture: it renders several times faster
    let edge: u32 = param("edge=").and_then(|e| e.parse().ok()).unwrap_or(0).min(4096);
    if param("zoom=").is_some() {
        // 1:1: a window of the full-size picture, x y w h in its pixels
        let num = |k: &str| param(k).and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
        let cropped = match state.full.lock() {
            Ok(g) => match g.as_ref() {
                Some(c) if c.id == id && c.crop_key == crop_key(&recipe.sanitized()) => c.cropped.clone(),
                _ => return fail(409), // not prepared for this photo and crop: the page asks again
            },
            Err(_) => return fail(500),
        };
        let started = std::time::Instant::now();
        let out = develop::render_region(&cropped, &recipe, num("x="), num("y="), num("w="), num("h="));
        return bmp_response(out, started, &format!("region {id}"));
    }
    let proxy = {
        let mut slot = match state.proxy.lock() {
            Ok(s) => s,
            Err(_) => return fail(500),
        };
        match slot.as_ref() {
            Some((cached, e, img)) if *cached == id && *e == edge => img.clone(),
            _ => {
                let dir = match state.previews.lock() {
                    Ok(d) => d.clone(),
                    Err(_) => return fail(500),
                };
                let Ok(img) = base_preview(state, &dir, id) else { return fail(404) };
                let img = if edge > 0 && img.width().max(img.height()) > edge { img.resize(edge, edge, image::imageops::FilterType::Triangle) } else { img };
                let img = Arc::new(img.to_rgb8());
                *slot = Some((id, edge, img.clone()));
                img
            }
        }
    };
    let started = std::time::Instant::now();
    let mut out = develop::render(&proxy, &recipe);
    // soft proofing: the picture as the chosen profile would reproduce it
    if param("proof=").is_some() {
        let setup = state.proof.lock().ok().and_then(|g| g.clone());
        if let Some(setup) = setup {
            if let Ok(p) = proof::apply(&out, &setup, param("gamut=").is_some()) {
                out = p;
            }
        }
    }
    // "show mask": a red wash over where one mask applies
    if let Some(mask_id) = param("overlay=") {
        if let Some(m) = recipe.sanitized().masks.iter().find(|m| m.id == mask_id) {
            out = masks::apply_overlay(&out, m, 0, 0, out.width(), out.height());
        }
    }
    bmp_response(out, started, &format!("render {id} edge={edge}"))
}

fn bmp_response(out: image::RgbImage, started: std::time::Instant, label: &str) -> tauri::http::Response<Vec<u8>> {
    let fail = |code: u16| tauri::http::Response::builder().status(code).body(Vec::new()).unwrap();
    // Uncompressed on purpose: this never leaves the machine, and JPEG encoding cost more than the edit itself.
    let mut bytes = Vec::with_capacity(out.as_raw().len() + 64);
    if image::DynamicImage::ImageRgb8(out).write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Bmp).is_err() {
        return fail(500);
    }
    if std::env::var_os("PENUMBRA_TIMING").is_some() {
        eprintln!("{label}: {:?}, {} bytes", started.elapsed(), bytes.len());
    }
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", "image/bmp")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .body(bytes)
        .unwrap()
}

/// `thumb://localhost/source?p=<file>`: a small picture of a photo in the folder being chosen from for import. Only files
/// inside that folder, and only supported photos, are ever served.
fn serve_source(state: &AppState, query: Option<&str>) -> tauri::http::Response<Vec<u8>> {
    let fail = |code: u16| tauri::http::Response::builder().status(code).body(Vec::new()).unwrap();
    let Some(file) = query.and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("p="))).and_then(|v| percent_encoding::percent_decode_str(v).decode_utf8().ok().map(|c| c.into_owned())) else { return fail(400) };
    let path = PathBuf::from(file);
    let (Ok(root), Ok(real)) = (state.import_root.lock().map(|r| r.clone()), std::fs::canonicalize(&path)) else { return fail(404) };
    match root {
        Some(root) if real.starts_with(&root) && media::kind_of(&real).is_some() => match media::source_thumb(&real, 160) {
            Ok(bytes) => tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", "image/jpeg")
                .header("Access-Control-Allow-Origin", "*")
                .header("Cache-Control", "private, max-age=600")
                .body(bytes)
                .unwrap(),
            Err(_) => fail(404),
        },
        _ => fail(403),
    }
}

/// `thumb://localhost/{id}/{thumb|standard}`. Serves only files from the previews folder.
fn serve_preview(state: &AppState, path: &str, query: Option<&str>) -> tauri::http::Response<Vec<u8>> {
    let not_found = || tauri::http::Response::builder().status(404).body(Vec::new()).unwrap();
    if let Some(rest) = path.trim_matches('/').strip_prefix("render/") {
        let Ok(id) = rest.parse::<i64>() else { return not_found() };
        return serve_render(state, id, query);
    }
    if path.trim_matches('/') == "source" {
        return serve_source(state, query);
    }
    let mut parts = path.trim_matches('/').split('/');
    let (Some(id), Some(level), None) = (parts.next(), parts.next(), parts.next()) else { return not_found() };
    let Ok(id) = id.parse::<i64>() else { return not_found() };
    if level != "thumb" && level != "standard" {
        return not_found();
    }
    let dir = match state.previews.lock() {
        Ok(d) => d.clone(),
        Err(_) => return not_found(),
    };
    // a preview that is not there (cleared, or never made) is made now, one at a time, from the original
    if !media::preview_path(&dir, id, level).is_file() {
        if let Ok(_turn) = state.build_lock.lock() {
            if !media::preview_path(&dir, id, level).is_file() {
                if let Ok((src, recipe)) = state.with(|c| Ok((c.photo_path(id)?, c.develop_recipe(id)?))) {
                    let _ = rebuild_one(&dir, id, &src, recipe.as_ref(), true);
                }
            }
        }
    }
    // the edited picture when the photo has one, otherwise the untouched preview
    let edited = std::fs::read(media::preview_path(&dir, id, &format!("e{level}"))).ok();
    match edited.map(Ok).unwrap_or_else(|| std::fs::read(media::preview_path(&dir, id, level))) {
        Ok(bytes) => tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", "image/jpeg")
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "private, max-age=3600")
            .body(bytes)
            .unwrap(),
        Err(_) => not_found(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState::new();
    let proto_state = state.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .on_window_event(|window, event| {
            // closing the main window ends the program: the second window goes with it
            if window.label() == "second" {
                if let tauri::WindowEvent::Destroyed = event {
                    let _ = window.app_handle().emit_to("main", "second:closed", ());
                }
            }
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    if let Some(w) = window.app_handle().get_webview_window("second") {
                        let _ = w.close();
                    }
                }
            }
        })
        .register_asynchronous_uri_scheme_protocol("thumb", move |_ctx, req, responder| {
            // off the main thread: a slow render must never freeze the window
            let state = proto_state.clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(serve_preview(&state, req.uri().path(), req.uri().query()));
            });
        })
        .setup(|app| {
            // the first catalog, the list of catalogs and where new ones go (PENUMBRA_CATALOG points a test run at its own folder)
            let (first, file, home) = match std::env::var("PENUMBRA_CATALOG") {
                Ok(p) if !p.is_empty() => {
                    let r = PathBuf::from(p);
                    let parent = r.parent().map(Path::to_path_buf).unwrap_or_else(|| r.clone());
                    (r, parent.join(catalogs::FILE_NAME), parent.join("catalogs"))
                }
                _ => {
                    let d = app.path().app_data_dir()?;
                    (d.join("catalog"), d.join(catalogs::FILE_NAME), d.join("catalogs"))
                }
            };
            // a program that closes by itself leaves nothing to read; a panic is written to crash.log beside the catalog list
            if let Some(log) = file.parent().map(|p| p.join("crash.log")) {
                std::panic::set_hook(Box::new(move |info| {
                    use std::io::Write;
                    let _ = std::fs::OpenOptions::new().create(true).append(true).open(&log).and_then(|mut f| writeln!(f, "{:?}\n{}\n{}\n", std::time::SystemTime::now(), info, std::backtrace::Backtrace::force_capture()));
                }));
            }
            let mut reg = catalogs::Registry::load(&file, &first);
            // the catalog that was open last time; if it will not open (its drive is gone), the first one
            let wanted = reg.current_entry().map(|e| PathBuf::from(&e.path)).unwrap_or_else(|| first.clone());
            let cat = match Catalog::open(&wanted) {
                Ok(c) => c,
                Err(_) => {
                    let id = reg.add("Main catalog", &first)?;
                    reg.current = id;
                    Catalog::open(&first)?
                }
            };
            let _ = cat.prune_orphan_previews();
            let _ = reg.save(&file);
            let st = app.state::<AppState>();
            *st.previews.lock().unwrap() = cat.previews_dir();
            schedule_backup(&wanted_or_first(&reg, &first));
            *st.cat.lock().unwrap() = Some(cat);
            *st.registry.lock().unwrap() = reg;
            *st.registry_file.lock().unwrap() = file;
            if let Ok(res) = app.path().resource_dir() {
                object::set_dir(res.join("resources").join("sam"));
            }
            let _ = licence_status_now(&st);
            *st.catalogs_home.lock().unwrap() = home.clone();
            // the AI connection's settings sit next to the list of catalogs; it starts only if the person had turned it on
            let mcp_file = file_parent_of(&st).join("mcp.json");
            st.mcp.lock().unwrap().settings = load_mcp_settings(&mcp_file);
            *st.mcp_file.lock().unwrap() = mcp_file;
            let handle = app.handle().clone();
            let _ = apply_mcp(&st, &handle);
            start_xmp_writer(st.inner().clone());
            start_watcher(handle.clone(), st.inner().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            catalog_info,
            catalog_details,
            photo_virtual_copy,
            smart_create,
            smart_update,
            smart_rules,
            smart_count,
            catalog_check,
            catalog_backup,
            catalog_last_backup,
            backup_auto_state,
            backup_auto_settings_set,
            backup_auto_now,
            backup_restore,
            licence_status,
            catalog_optimize,
            volume_space,
            open_in_editor,
            perf_get,
            perf_set,
            photo_delete_preview,
            photo_delete_from_disk,
            photo_relink,
            folder_sync_preview,
            folder_sync_run,
            photo_rename_copy,
            import_cards,
            display_profile,
            cache_trim,
            photo_merge_hdr,
            photo_merge_pano,
            photo_edit_copy,
            photo_merge_focus,
            photo_ai_denoise,
            second_open,
            second_close,
            second_show,
            proof_set,
            watch_set,
            watch_status,
            catalog_export_photos,
            catalog_import_from,
            stack_group,
            stack_auto,
            stack_similar,
            stack_ungroup,
            stack_remove,
            stack_collapse,
            stack_make_top,
            smart_info,
            smart_build,
            open_folder,
            keyword_set_options,
            collection_set_create,
            collection_move,
            folder_rename,
            folder_move,
            licence_enter,
            cache_info,
            cache_rebuild,
            cache_clear,
            xmp_status,
            xmp_set_auto,
            xmp_write_now,
            xmp_read_now,
            missing_scan,
            relink_preview,
            relink_root,
            relink_search,
            book_list,
            book_create,
            book_get,
            book_save,
            book_delete,
            book_export_pdf,
            mcp_status,
            mcp_set_enabled,
            mcp_new_token,
            catalog_list,
            catalog_create,
            catalog_open,
            catalog_switch,
            catalog_rename,
            catalog_remove,
            import_scan,
            import_list,
            portrait_detect,
            export_preview,
            import_run,
            photo_query,
            metadata_values,
            folder_list,
            photo_set_rating,
            photo_set_flag,
            photo_set_label,
            export_run,
            enlarge_info,
            cull_scan,
            mask_subject,
            mask_person,
            mask_depth,
            mask_object,
            advise_photo,
            enlarge_preview,
            photo_ids,
            photo_remove,
            collection_list,
            collection_create,
            collection_rename,
            collection_delete,
            collection_add,
            collection_remove,
            collection_set_target,
            quick_toggle,
            keyword_list,
            keyword_add,
            keyword_remove,
            keywords_for,
            metadata_get,
            metadata_set,
            develop_get,
            develop_save,
            develop_zoom_open,
            develop_zoom_close,
            develop_auto,
            develop_spot_source,
            develop_find_dust,
            preset_list,
            preset_create,
            preset_rename,
            preset_delete,
            snapshot_list,
            snapshot_create,
            snapshot_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}

#[cfg(test)]
mod catalog_tests {
    use super::*;

    #[test]
    fn a_profile_gives_its_name_in_the_old_or_the_new_form_and_a_non_profile_gives_none() {
        // a minimal profile: 128 byte header ending "acsp" at 36, one tag called desc
        let header = |tags: Vec<(&[u8; 4], Vec<u8>)>| {
            let mut out = vec![0u8; 128];
            out[36..40].copy_from_slice(b"acsp");
            out.extend((tags.len() as u32).to_be_bytes());
            let mut offset = 128 + 4 + tags.len() * 12;
            let mut data: Vec<u8> = vec![];
            for (sig, d) in &tags {
                out.extend(*sig);
                out.extend((offset as u32).to_be_bytes());
                out.extend((d.len() as u32).to_be_bytes());
                offset += d.len();
                data.extend(d);
            }
            out.extend(data);
            out
        };
        // version 2: "desc" type, a count and the ASCII text
        let mut v2 = b"desc\0\0\0\0".to_vec();
        let name = b"Test Monitor sRGB\0";
        v2.extend((name.len() as u32).to_be_bytes());
        v2.extend(name);
        assert_eq!(icc_description(&header(vec![(b"desc", v2)])).as_deref(), Some("Test Monitor sRGB"));
        // version 4: "mluc" type, one record of UTF-16
        let text: Vec<u8> = "DELL U2723QE".encode_utf16().flat_map(|u| u.to_be_bytes()).collect();
        let mut v4 = b"mluc\0\0\0\0".to_vec();
        v4.extend(1u32.to_be_bytes());
        v4.extend(12u32.to_be_bytes());
        v4.extend(b"enUS");
        v4.extend((text.len() as u32).to_be_bytes());
        v4.extend(28u32.to_be_bytes());
        v4.extend(&text);
        assert_eq!(icc_description(&header(vec![(b"cprt", vec![0; 8]), (b"desc", v4)])).as_deref(), Some("DELL U2723QE"));
        assert_eq!(icc_description(b"not a profile at all"), None);
        assert_eq!(icc_description(&header(vec![])), None);
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("mon.icc");
        std::fs::write(&p, header(vec![(b"desc", { let mut v = b"desc\0\0\0\0".to_vec(); v.extend(9u32.to_be_bytes()); v.extend(b"sRGB IEC\0"); v })])).unwrap();
        let shown = profile_from_file(&p);
        assert_eq!((shown.name.as_str(), shown.is_srgb), ("sRGB IEC", true));
        let q = dir.path().join("wide.icm");
        std::fs::write(&q, b"junk").unwrap();
        assert_eq!(profile_from_file(&q).name, "wide.icm", "no name inside: the file name stands in");
    }
    #[test]
    fn cards_are_the_removable_drives_and_any_drive_with_a_dcim_folder_but_never_the_system_drive() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let c = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(a.path().join("DCIM")).unwrap();
        let roots = |p: &Path| p.to_string_lossy().to_string();
        let list = vec![(roots(a.path()), false), (roots(b.path()), true), (roots(c.path()), false)];
        let cards = cards_among(&list, "Z:\\");
        assert_eq!(cards.len(), 2, "the plain fixed drive c is not a card");
        assert!(cards[0].has_dcim && cards[0].path.ends_with("/DCIM"), "the DCIM folder is what is imported");
        assert!(cards[1].removable && !cards[1].has_dcim && cards[1].path == b.path().to_string_lossy().replace('\\', "/"));
        // the system drive is left out even if it has a DCIM folder
        assert!(cards_among(&list, &roots(a.path())).iter().all(|k| !k.has_dcim));
    }
    #[test]
    fn preview_limits_delete_the_old_and_then_the_oldest_until_the_rest_fit_and_leave_other_files_alone() {
        let dir = tempfile::tempdir().unwrap();
        let day = std::time::Duration::from_secs(86_400);
        let make = |name: &str, bytes: usize, age_days: u64| {
            let p = dir.path().join(name);
            std::fs::write(&p, vec![1u8; bytes]).unwrap();
            let f = std::fs::File::options().write(true).open(&p).unwrap();
            f.set_modified(std::time::SystemTime::now() - day * age_days as u32).unwrap();
        };
        make("1_standard.jpg", 1000, 100);
        make("2_standard.jpg", 1000, 50);
        make("3_thumb.jpg", 100, 10);
        make("4_standard.jpg", 1000, 1);
        make("notes.txt", 5000, 400);
        let left = || {
            let mut v: Vec<String> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            v.sort();
            v
        };
        assert_eq!(trim_previews(dir.path(), 0, 0), (0, 0), "no limits: nothing goes");
        // older than 60 days: only the first goes
        assert_eq!(trim_previews(dir.path(), 0, 60), (1, 1000));
        // a size limit of 1200 bytes: the oldest go until 3_thumb + 4_standard (1100) are left
        assert_eq!(trim_previews(dir.path(), 1200, 0), (1, 1000));
        assert_eq!(left(), vec!["3_thumb.jpg", "4_standard.jpg", "notes.txt"]);
        assert_eq!(trim_previews(dir.path(), 1200, 0), (0, 0), "already within the limit");
    }

    fn state_in(dir: &Path) -> AppState {
        let st = AppState::new();
        let first = dir.join("catalog");
        let reg = catalogs::Registry::load(&dir.join(catalogs::FILE_NAME), &first);
        activate(&st, &first).unwrap();
        *st.registry.lock().unwrap() = reg;
        *st.registry_file.lock().unwrap() = dir.join(catalogs::FILE_NAME);
        *st.catalogs_home.lock().unwrap() = dir.join("catalogs");
        st
    }
    fn names(l: &CatalogList) -> Vec<&str> {
        l.items.iter().map(|i| i.name.as_str()).collect()
    }
    fn open_name(st: &AppState) -> String {
        st.registry.lock().unwrap().current_entry().unwrap().name.clone()
    }

    #[test]
    fn a_new_catalog_is_empty_separate_from_the_others_and_the_one_that_is_open() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path());
        st.with(|c| c.collection_create("Only in main").map(|_| ())).unwrap();
        let l = create_catalog(&st, "Weddings", None).unwrap();
        assert_eq!(names(&l), ["Main catalog", "Weddings"]);
        assert_eq!(open_name(&st), "Weddings");
        assert!(l.items[1].current && !l.items[0].current);
        assert!(dir.path().join("catalogs").join("Weddings").join("catalog.db").is_file());
        // the new catalog has none of the main catalog's collections
        let weddings = st.with(|c| c.collections()).unwrap();
        assert!(!weddings.iter().any(|c| c.name == "Only in main"), "{weddings:?}");
        st.with(|c| c.collection_create("Only in weddings").map(|_| ())).unwrap();
        // back to the main catalog: its own collection is there and the other is not
        let main_id = l.items[0].id.clone();
        switch_catalog(&st, &main_id).unwrap();
        let main = st.with(|c| c.collections()).unwrap();
        assert!(main.iter().any(|c| c.name == "Only in main") && !main.iter().any(|c| c.name == "Only in weddings"), "{main:?}");
        // and the list was saved, so a restart finds it
        let again = catalogs::Registry::load(&dir.path().join(catalogs::FILE_NAME), &dir.path().join("catalog"));
        assert_eq!((again.items.len(), again.current.as_str()), (2, main_id.as_str()));
    }

    #[test]
    fn the_same_name_twice_makes_two_folders_and_a_bad_name_or_place_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path());
        create_catalog(&st, "Trip", None).unwrap();
        let l = create_catalog(&st, "Trip", None).unwrap();
        assert_eq!(l.items.len(), 3);
        assert!(dir.path().join("catalogs").join("Trip").is_dir() && dir.path().join("catalogs").join("Trip 2").is_dir());
        let before = open_name(&st);
        assert!(create_catalog(&st, "   ", None).is_err());
        assert_eq!(open_name(&st), before);
        assert_eq!(list_catalogs(&st).unwrap().items.len(), 3, "nothing was added");
        // somewhere the person chose
        let elsewhere = dir.path().join("Photos on the big drive");
        create_catalog(&st, "Client work", Some(elsewhere.to_str().unwrap())).unwrap();
        assert!(elsewhere.join("Client work").join("catalog.db").is_file());
    }

    #[test]
    fn an_existing_catalog_folder_can_be_opened_once_and_a_folder_that_is_not_one_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path());
        let other = dir.path().join("elsewhere").join("Old shoots");
        drop(Catalog::open(&other).unwrap()); // a catalog made by someone else, or by an earlier install
        let l = open_catalog(&st, other.to_str().unwrap()).unwrap();
        assert_eq!(names(&l), ["Main catalog", "Old shoots"]);
        assert_eq!(open_name(&st), "Old shoots");
        let again = open_catalog(&st, other.to_str().unwrap()).unwrap();
        assert_eq!(again.items.len(), 2, "the same folder is not listed twice");
        let empty = dir.path().join("not a catalog");
        std::fs::create_dir_all(&empty).unwrap();
        let e = open_catalog(&st, empty.to_str().unwrap()).unwrap_err();
        assert!(e.contains("catalog.db"), "{e}");
        assert_eq!(open_name(&st), "Old shoots", "a refused folder leaves the open catalog alone");
        assert!(open_catalog(&st, dir.path().join("missing").to_str().unwrap()).is_err());
    }

    #[test]
    fn switching_says_so_when_the_folder_has_gone_and_keeps_the_open_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path());
        let main_id = list_catalogs(&st).unwrap().current;
        let l = create_catalog(&st, "Gone soon", None).unwrap();
        let gone_id = l.current.clone();
        switch_catalog(&st, &main_id).unwrap();
        std::fs::remove_dir_all(dir.path().join("catalogs").join("Gone soon")).unwrap();
        let listed = list_catalogs(&st).unwrap();
        let gone = listed.items.iter().find(|i| i.id == gone_id).unwrap();
        assert!(!gone.exists && gone.photos.is_none());
        let e = switch_catalog(&st, &gone_id).unwrap_err();
        assert!(e.contains("Gone soon") && e.contains("not there any more"), "{e}");
        assert_eq!(open_name(&st), "Main catalog");
        assert!(switch_catalog(&st, "nope").is_err());
        // switching to the one that is already open is fine and changes nothing
        assert_eq!(switch_catalog(&st, &main_id).unwrap().current, main_id);
    }

    #[test]
    fn switching_lets_go_of_what_was_remembered_about_the_old_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path());
        *st.import_root.lock().unwrap() = Some(dir.path().to_path_buf());
        st.edit_gen.lock().unwrap().insert(7, 3);
        let before = st.previews.lock().unwrap().clone();
        create_catalog(&st, "Fresh", None).unwrap();
        assert!(st.import_root.lock().unwrap().is_none());
        assert!(st.edit_gen.lock().unwrap().is_empty());
        assert!(st.proxy.lock().unwrap().is_none() && st.full.lock().unwrap().is_none());
        assert_ne!(*st.previews.lock().unwrap(), before, "previews now come from the new catalog's own folder");
        assert!(st.previews.lock().unwrap().starts_with(dir.path().join("catalogs").join("Fresh")));
    }

    #[test]
    fn rename_and_remove_work_on_the_list_and_never_touch_the_files() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path());
        let first = list_catalogs(&st).unwrap().current;
        let l = create_catalog(&st, "Temp", None).unwrap();
        let temp_id = l.current.clone();
        st.registry.lock().unwrap().rename(&temp_id, "Temp renamed").unwrap();
        assert_eq!(open_name(&st), "Temp renamed");
        switch_catalog(&st, &first).unwrap();
        st.registry.lock().unwrap().remove(&temp_id).unwrap();
        assert_eq!(list_catalogs(&st).unwrap().items.len(), 1);
        assert!(dir.path().join("catalogs").join("Temp").join("catalog.db").is_file(), "the files stay");
        assert!(st.registry.lock().unwrap().remove(&first).is_err(), "the open one cannot go");
    }

    #[test]
    fn books_are_kept_in_the_catalog_listed_newest_first_and_stay_with_their_own_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path());
        assert!(st.with(|c| c.book_list()).unwrap().is_empty());
        let a = st.with(|c| c.book_create(&book::Book { name: "First".into(), ..Default::default() })).unwrap();
        let b = st.with(|c| c.book_create(&book::Book { name: "Second".into(), ..Default::default() })).unwrap();
        let list = st.with(|c| c.book_list()).unwrap();
        assert_eq!(list.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["Second", "First"]);
        let mut edited = st.with(|c| c.book_get(a)).unwrap();
        edited.name = "  Renamed  ".into();
        edited.pages.push(book::Page::default());
        let saved = st.with(|c| c.book_save(a, &edited)).unwrap();
        assert_eq!((saved.name.as_str(), saved.pages.len()), ("Renamed", 2));
        assert_eq!(st.with(|c| c.book_get(a)).unwrap(), saved);
        assert_eq!(st.with(|c| c.book_list()).unwrap().iter().find(|e| e.id == a).unwrap().pages, 2);
        assert!(st.with(|c| c.book_save(999, &edited)).is_err());
        assert!(st.with(|c| c.book_get(999)).is_err());
        st.with(|c| c.book_delete(b)).unwrap();
        assert_eq!(st.with(|c| c.book_list()).unwrap().len(), 1);
        // a second catalog has its own books
        let other = dir.path().join("other");
        activate(&st, &other).unwrap();
        assert!(st.with(|c| c.book_list()).unwrap().is_empty());
    }

    fn two_photos(dir: &Path) -> (AppState, Vec<i64>, PathBuf) {
        let st = state_in(dir);
        let photos = dir.join("photos");
        std::fs::create_dir_all(&photos).unwrap();
        for (n, shade) in [("one.jpg", 40u8), ("two.jpg", 200u8)] {
            image::RgbImage::from_fn(60, 40, |x, y| image::Rgb([shade, (x * 4) as u8, (y * 6) as u8])).save(photos.join(n)).unwrap();
        }
        let files = Catalog::list_files(&photos);
        st.with(|c| c.import_files(&files, &photos, "add", None, |_, _| {}).map(|_| ())).unwrap();
        let ids = st.with(|c| c.all_photo_ids()).unwrap();
        (st, ids, photos)
    }

    #[test]
    fn writing_sidecars_makes_a_file_beside_each_photo_with_what_the_catalog_knows_and_a_second_write_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (st, ids, photos) = two_photos(dir.path());
        st.with(|c| {
            c.set_rating(&[ids[0]], 4)?;
            c.set_label(&[ids[0]], Some("green"))?;
            c.set_flag(&[ids[0]], 1)?;
            c.keyword_add(&[ids[0]], &["Places".to_string(), "Lake".to_string()])?;
            c.metadata_set(&[ids[0]], &catalog::MetaPatch { title: Some("Sunrise".into()), creator: Some("Bennett".into()), ..Default::default() })
        })
        .unwrap();
        assert!(st.with(|c| Ok(c.changed_photo_count())).unwrap() >= 1);
        let out = xmp_write(&st, &st.with(|c| c.changed_photo_ids(100)).unwrap(), &|_, _| {}).unwrap();
        assert_eq!((out.written, out.unchanged, out.failed.len(), out.left_alone.len()), (1, 0, 0, 0), "{:?}", out.failed);
        let path = photos.join("one.jpg.xmp");
        let sc = xmp::parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(sc.ours);
        assert_eq!((sc.rating, sc.flag, sc.label.as_deref(), sc.title.as_deref(), sc.creator.as_deref()), (Some(4), Some(1), Some("green"), Some("Sunrise"), Some("Bennett")));
        assert_eq!(sc.keywords, vec![vec!["Places".to_string(), "Lake".to_string()]]);
        assert!(!photos.join("two.jpg.xmp").exists(), "an untouched photo gets none until asked");
        assert_eq!(st.with(|c| Ok(c.changed_photo_count())).unwrap(), 0, "written, so nothing is waiting");
        let again = xmp_write(&st, &ids, &|_, _| {}).unwrap();
        assert_eq!((again.written, again.unchanged), (1, 1), "two.jpg is new, one.jpg is the same");
        // the original photos were not touched
        assert!(image::open(photos.join("one.jpg")).is_ok());
    }

    #[test]
    fn a_sidecar_from_another_program_is_never_overwritten_and_a_garbled_one_is_left_alone_too() {
        let dir = tempfile::tempdir().unwrap();
        let (st, ids, photos) = two_photos(dir.path());
        let lr = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmp:Rating=\"2\"/></rdf:RDF></x:xmpmeta>";
        std::fs::write(photos.join("one.jpg.xmp"), lr).unwrap();
        std::fs::write(photos.join("two.jpg.xmp"), "this is not xml").unwrap();
        st.with(|c| c.set_rating(&ids, 5)).unwrap();
        let out = xmp_write(&st, &ids, &|_, _| {}).unwrap();
        assert_eq!((out.written, out.left_alone.len()), (0, 2), "{out:?}");
        assert_eq!(std::fs::read_to_string(photos.join("one.jpg.xmp")).unwrap(), lr);
        assert_eq!(std::fs::read_to_string(photos.join("two.jpg.xmp")).unwrap(), "this is not xml");
        // reading the other program's sidecar still works, and says the garbled one is unreadable
        let r = xmp_read(&st, &ids, false, &|_, _| {}).unwrap();
        assert_eq!((r.found, r.differ, r.unreadable.len()), (2, 1, 1), "{:?}", r.unreadable);
        assert_eq!(r.kinds.get("rating"), Some(&1));
    }

    #[test]
    fn reading_sidecars_shows_what_would_change_then_makes_the_catalog_agree_without_taking_keywords_or_edits_away() {
        let dir = tempfile::tempdir().unwrap();
        let (st, ids, photos) = two_photos(dir.path());
        st.with(|c| {
            c.set_rating(&[ids[0]], 2)?;
            c.keyword_add(&[ids[0]], &["Mine".to_string()])
        })
        .unwrap();
        xmp_write(&st, &ids, &|_, _| {}).unwrap();
        // someone edits the sidecar: a better rating, a label, a keyword, and an edit
        let path = photos.join("one.jpg.xmp");
        let mut sc = xmp::parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
        sc.rating = Some(5);
        sc.label = Some("red".into());
        sc.keywords.push(vec!["Added".into()]);
        let mut recipe = develop::Recipe::default();
        recipe.exposure = 1.0;
        sc.recipe = Some(serde_json::to_string(&recipe).unwrap());
        std::fs::write(&path, xmp::write(&sc)).unwrap();
        let look = xmp_read(&st, &ids, false, &|_, _| {}).unwrap();
        assert_eq!((look.found, look.differ, look.applied), (2, 1, 0));
        assert_eq!(look.kinds.keys().cloned().collect::<Vec<_>>(), ["edits", "keywords", "label", "rating"]);
        assert_eq!(st.with(|c| c.sidecar_data(ids[0])).unwrap().rating, Some(2), "looking changes nothing");
        let done = xmp_read(&st, &ids, true, &|_, _| {}).unwrap();
        assert_eq!(done.applied, 1);
        let now = st.with(|c| c.sidecar_data(ids[0])).unwrap();
        assert_eq!((now.rating, now.label.as_deref()), (Some(5), Some("red")));
        assert!(now.keywords.contains(&vec!["Mine".to_string()]) && now.keywords.contains(&vec!["Added".to_string()]), "keywords are added to, never removed: {:?}", now.keywords);
        assert_eq!(st.with(|c| c.develop_recipe(ids[0])).unwrap().unwrap().exposure, 1.0);
        let history = st.with(|c| c.develop_get(ids[0])).unwrap().history;
        assert!(history.iter().any(|h| h.label == "Read from sidecar"), "so Undo can take it back");
        assert_eq!(st.with(|c| Ok(c.changed_photo_count())).unwrap(), 0, "the sidecar is what the catalog holds now");
        assert_eq!(xmp_read(&st, &ids, false, &|_, _| {}).unwrap().differ, 0, "and nothing differs any more");
    }

    #[test]
    fn a_photo_whose_file_is_gone_is_counted_not_failed_and_the_automatic_switch_is_kept_in_the_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let (st, ids, photos) = two_photos(dir.path());
        std::fs::remove_file(photos.join("two.jpg")).unwrap();
        let out = xmp_write(&st, &ids, &|_, _| {}).unwrap();
        assert_eq!((out.written, out.missing, out.failed.len()), (1, 1, 0));
        assert!(!st.with(|c| Ok(c.xmp_auto())).unwrap());
        st.with(|c| c.set_xmp_auto(true)).unwrap();
        assert!(st.with(|c| Ok(c.xmp_auto())).unwrap());
        // an edit marks the photo as changed
        let mut r = develop::Recipe::default();
        r.exposure = 0.7;
        st.with(|c| c.clear_changed(&ids)).unwrap();
        st.with(|c| c.develop_save(ids[0], &r, None)).unwrap();
        assert_eq!(st.with(|c| c.changed_photo_ids(10)).unwrap(), vec![ids[0]]);
    }

    #[test]
    fn previews_are_counted_cleared_and_made_again_and_a_missing_one_is_made_when_a_tool_needs_it() {
        let dir = tempfile::tempdir().unwrap();
        let (st, ids, _photos) = two_photos(dir.path());
        let pdir = st.previews.lock().unwrap().clone();
        let items = st.with(|c| c.preview_items()).unwrap();
        assert_eq!(items.len(), 2);
        // nothing is made yet: both photos lack previews
        let info = cache_info_of(&st).unwrap();
        assert_eq!((info.files, info.photos, info.without_preview, info.edited_without), (0, 2, 2, 0));
        // an edit on the first photo
        let mut r = develop::Recipe::default();
        r.exposure = 0.8;
        st.with(|c| c.develop_save(ids[0], &r, None)).unwrap();
        let items = st.with(|c| c.preview_items()).unwrap();
        for (id, path, recipe) in &items {
            rebuild_one(&pdir, *id, path, recipe.as_ref(), true).unwrap();
        }
        let info = cache_info_of(&st).unwrap();
        assert_eq!((info.files, info.without_preview, info.edited_without), (6, 0, 0), "thumb and standard for two photos, and the edited pair for one");
        assert!(info.edited_bytes > 0 && info.base_bytes > 0 && info.bytes == info.edited_bytes + info.base_bytes);
        // the edited preview is a different picture from the base one
        assert_ne!(std::fs::read(media::preview_path(&pdir, ids[0], "estandard")).unwrap(), std::fs::read(media::preview_path(&pdir, ids[0], "standard")).unwrap());
        // clearing the edited ones leaves the base ones; the plan for what is missing is just the edited photo, with no base needed
        assert_eq!(clear_previews(&pdir, false), 2);
        let info = cache_info_of(&st).unwrap();
        assert_eq!((info.files, info.without_preview, info.edited_without), (4, 0, 1));
        let plan = rebuild_plan(&pdir, st.with(|c| c.preview_items()).unwrap(), true);
        assert_eq!(plan.len(), 1);
        assert_eq!((plan[0].0, plan[0].3, plan[0].2.is_some()), (ids[0], false, true));
        rebuild_one(&pdir, plan[0].0, &plan[0].1, plan[0].2.as_ref(), plan[0].3).unwrap();
        assert_eq!(cache_info_of(&st).unwrap().edited_without, 0);
        // clearing all leaves nothing; everything is planned, and a tool that needs a base preview makes it
        assert_eq!(clear_previews(&pdir, true), 6);
        assert_eq!(cache_info_of(&st).unwrap().files, 0);
        assert_eq!(rebuild_plan(&pdir, st.with(|c| c.preview_items()).unwrap(), true).len(), 2);
        assert_eq!(rebuild_plan(&pdir, st.with(|c| c.preview_items()).unwrap(), false).len(), 2);
        let img = base_preview(&st, &pdir, ids[1]).unwrap();
        assert!(img.width() > 0 && media::preview_path(&pdir, ids[1], "standard").is_file() && media::preview_path(&pdir, ids[1], "thumb").is_file());
        // a photo whose file is gone cannot be made, and says so rather than failing silently
        std::fs::remove_file(st.with(|c| c.photo_path(ids[0])).unwrap()).unwrap();
        let err = base_preview(&st, &pdir, ids[0]).unwrap_err();
        assert!(err.contains("could not be made"), "{err}");
        // files that are not previews are never touched by clearing
        std::fs::write(pdir.join("notes.txt"), "keep").unwrap();
        clear_previews(&pdir, true);
        assert!(pdir.join("notes.txt").is_file());
    }

    #[test]
    fn a_virtual_copy_never_writes_or_reads_a_sidecar_so_it_cannot_clash_with_its_photo() {
        let dir = tempfile::tempdir().unwrap();
        let (st, ids, photos) = two_photos(dir.path());
        st.with(|c| c.set_rating(&[ids[0]], 3)).unwrap();
        let copy = st.with(|c| c.virtual_copies(&[ids[0]])).unwrap()[0].1;
        st.with(|c| c.set_rating(&[copy], 5)).unwrap();
        let mut all = ids.clone();
        all.push(copy);
        let out = xmp_write(&st, &all, &|_, _| {}).unwrap();
        assert_eq!(out.written, 2, "one for each photo that has a file");
        let sc = xmp::parse(&std::fs::read_to_string(photos.join("one.jpg.xmp")).unwrap()).unwrap();
        assert_eq!(sc.rating, Some(3), "the photo's own rating, not the copy's");
        // reading does not hand the sidecar to the copy either
        let r = xmp_read(&st, &all, false, &|_, _| {}).unwrap();
        assert_eq!(r.found, 2);
        assert_eq!(xmp_ids(&st, "all", vec![]).unwrap().len(), 2);
    }
}

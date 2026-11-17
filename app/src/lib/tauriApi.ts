import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import type { Api } from './types'

// WebView2 (Windows) serves a custom protocol as http://<name>.localhost; WebKitGTK (Linux) and WKWebView (Mac) as <name>://localhost
const THUMB = /windows/i.test(navigator.userAgent) ? 'http://thumb.localhost' : 'thumb://localhost'

/** The real core. Errors come back as plain strings from Rust and are rethrown as Error. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args)
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : String(e))
  }
}

/**
 * Photo ids start from 1 in every catalog, and pictures are kept by the window for an hour by their address, so the address of
 * every picture carries a number that goes up each time another catalog is opened.
 */
let epoch = 0
function switched<T>(result: T): T {
  epoch += 1
  return result
}

export const tauriApi: Api = {
  isMock: false,
  catalogInfo: () => call('catalog_info'),
  bookList: () => call('book_list'),
  bookCreate: (name) => call('book_create', { name: name ?? null }),
  bookGet: (id) => call('book_get', { id }),
  bookSave: (id, book) => call('book_save', { id, book }),
  bookDelete: (id) => call('book_delete', { id }),
  bookExportPdf: (id, destination) => call('book_export_pdf', { id, destination }),
  catalogCheck: () => call('catalog_check'),
  photoVirtualCopy: (ids) => call('photo_virtual_copy', { ids }),
  smartCreate: (name, rules) => call('smart_create', { name, rules }),
  smartUpdate: (id, name, rules) => call('smart_update', { id, name, rules }),
  smartRules: (id) => call('smart_rules', { id }),
  smartCount: (rules) => call('smart_count', { rules }),
  cacheInfo: () => call('cache_info'),
  cacheRebuild: (which) => call('cache_rebuild', { which }),
  cacheClear: (which) => call('cache_clear', { which }),
  xmpStatus: () => call('xmp_status'),
  xmpSetAuto: (on) => call('xmp_set_auto', { on }),
  xmpWriteNow: (scope, ids) => call('xmp_write_now', { scope, ids }),
  xmpReadNow: (scope, ids, apply) => call('xmp_read_now', { scope, ids, apply }),
  missingScan: () => call('missing_scan'),
  relinkPreview: (rootId, newFolder) => call('relink_preview', { rootId, newFolder }),
  relinkRoot: (rootId, newFolder) => call('relink_root', { rootId, newFolder }),
  relinkSearch: (folder) => call('relink_search', { folder }),
  cacheTrim: (maxBytes, maxAgeDays) => call('cache_trim', { maxBytes, maxAgeDays }),
  photoAiDenoise: (id, amount, iso) => call('photo_ai_denoise', { id, amount, iso }),
  photoMergeFocus: (ids, align) => call('photo_merge_focus', { ids, align }),
  photoEditCopy: (id) => call('photo_edit_copy', { id }),
  photoMergePano: (ids) => call('photo_merge_pano', { ids }),
  photoMergeHdr: (ids, align) => call('photo_merge_hdr', { ids, align }),
  secondOpen: () => call('second_open'),
  secondClose: () => call('second_close'),
  secondShow: (show) => call('second_show', { show }),
  watchSet: (config) => call('watch_set', { config }),
  watchStatus: () => call('watch_status'),
  catalogExportPhotos: (ids, destination, name, withPreviews) => call('catalog_export_photos', { ids, destination, name, withPreviews }),
  catalogImportFrom: (path, withPreviews) => call('catalog_import_from', { path, withPreviews }),
  stackGroup: (ids) => call('stack_group', { ids }),
  stackAuto: (ids, gapSeconds) => call('stack_auto', { ids, gapSeconds }),
  stackSimilar: (ids, maxDistance) => call('stack_similar', { ids, maxDistance }),
  stackUngroup: (ids) => call('stack_ungroup', { ids }),
  stackRemove: (ids) => call('stack_remove', { ids }),
  stackCollapse: (stackId, collapsed) => call('stack_collapse', { stackId, collapsed }),
  stackMakeTop: (id) => call('stack_make_top', { id }),
  smartInfo: (ids) => call('smart_info', { ids }),
  smartBuild: (ids) => call('smart_build', { ids }),
  catalogDetails: () => call('catalog_details'),
  displayProfile: () => call('display_profile'),
  folderSyncPreview: (folderId) => call('folder_sync_preview', { folderId }),
  folderSyncRun: (folderId, importNew, removeGone) => call('folder_sync_run', { folderId, importNew, removeGone }),
  importCards: () => call('import_cards'),
  openFolder: (path) => call('open_folder', { path }),
  photoRenameCopy: (id, name) => call('photo_rename_copy', { id, name }),
  photoRelink: (id, file) => call('photo_relink', { id, file }),
  pickPhotoFile: async (title) => {
    const r = await open({ multiple: false, title })
    return typeof r === 'string' ? r : null
  },
  catalogBackup: (destination) => call('catalog_backup', { destination }),
  perfGet: () => call('perf_get'),
  perfSet: (threads) => call('perf_set', { threads }),
  openInEditor: (path, editor) => call('open_in_editor', { path, editor }),
  catalogLastBackup: () => call('catalog_last_backup'),
  licenceStatus: () => call('licence_status'),
  appVersion: () => call('app_version'),
  updateCheck: () => call('update_check'),
  updateOpen: (version) => call('update_open', { version }),
  catalogOptimize: () => call('catalog_optimize'),
  volumeSpace: (path) => call('volume_space', { path }),
  licenceEnter: (key) => call('licence_enter', { key }),
  backupAutoState: () => call('backup_auto_state'),
  backupAutoSettingsSet: (on, everyDays, keep) => call('backup_auto_settings_set', { on, everyDays, keep }),
  backupAutoNow: () => call('backup_auto_now'),
  backupRestore: (file) => call('backup_restore', { file }),
  mcpStatus: () => call('mcp_status'),
  mcpSetEnabled: (enabled) => call('mcp_set_enabled', { enabled }),
  mcpNewToken: () => call('mcp_new_token'),
  catalogList: () => call('catalog_list'),
  catalogCreate: async (name, location) => switched(await call('catalog_create', { name, location: location ?? null })),
  catalogOpen: async (path) => switched(await call('catalog_open', { path })),
  catalogSwitch: async (id) => switched(await call('catalog_switch', { id })),
  catalogRename: (id, name) => call('catalog_rename', { id, name }),
  catalogRemove: (id) => call('catalog_remove', { id }),
  pickFolder: async (title) => {
    const r = await open({ directory: true, multiple: false, title })
    return typeof r === 'string' ? r : null
  },
  importScan: (source) => call('import_scan', { source }),
  importList: (source) => call('import_list', { source }),
  metadataValues: () => call('metadata_values'),
  portraitDetect: (id, recipe) => call('portrait_detect', { id, recipe }),
  importThumbUrl: (path) => `${THUMB}/source?p=${encodeURIComponent(path)}`,
  importRun: (source, mode, destination, files, options) => call('import_run', { source, mode, destination, files: files ?? null, options: options ?? null }),
  photoQuery: (query) => call('photo_query', { query }),
  folderList: () => call('folder_list'),
  folderRename: (folderId, newName) => call('folder_rename', { folderId, newName }),
  folderMove: (folderId, destination) => call('folder_move', { folderId, destination }),
  setRating: (ids, rating) => call('photo_set_rating', { ids, rating }),
  setFlag: (ids, flag) => call('photo_set_flag', { ids, flag }),
  setLabel: (ids, label) => call('photo_set_label', { ids, label }),
  exportRun: (ids, destination, settings, newFolder) => call('export_run', { ids, destination, settings, newFolder: newFolder ?? null }),
  exportPreview: (id, settings) => call('export_preview', { id, settings }),
  enlargeInfo: (id, recipe) => call('enlarge_info', { id, recipe }),
  advisePhoto: (id, recipe) => call('advise_photo', { id, recipe }),
  maskObject: (id, recipe, x, y) => call('mask_object', { id, recipe, x, y, notX: null, notY: null }),
  maskDepth: (id, recipe) => call('mask_depth', { id, recipe }),
  maskSubject: (id, recipe) => call('mask_subject', { id, recipe }),
  maskPerson: (id, recipe, part) => call('mask_person', { id, recipe, part }),
  cullScan: (ids) => call('cull_scan', { ids }),
  enlargePreview: (id, recipe, method) => call('enlarge_preview', { id, recipe, method }),
  pickImage: async (title) => {
    const r = await open({ multiple: false, title, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
    return typeof r === 'string' ? r : null
  },
  photoIds: (query) => call('photo_ids', { query }),
  photoRemove: (ids) => call('photo_remove', { ids }),
  photoDeletePreview: (ids) => call('photo_delete_preview', { ids }),
  photoDeleteFromDisk: (ids) => call('photo_delete_from_disk', { ids }),
  collectionSetCreate: (name, parent) => call('collection_set_create', { name, parent }),
  collectionMove: (id, parent) => call('collection_move', { id, parent }),
  collectionList: () => call('collection_list'),
  collectionCreate: (name) => call('collection_create', { name }),
  collectionRename: (id, name) => call('collection_rename', { id, name }),
  collectionDelete: (id) => call('collection_delete', { id }),
  collectionAdd: (id, photoIds) => call('collection_add', { id, photoIds }),
  collectionRemove: (id, photoIds) => call('collection_remove', { id, photoIds }),
  collectionSetTarget: (id) => call('collection_set_target', { id }),
  quickToggle: (photoIds) => call('quick_toggle', { photoIds }),
  keywordList: () => call('keyword_list'),
  keywordAdd: (photoIds, path) => call('keyword_add', { photoIds, path }),
  keywordRemove: (photoIds, keywordId) => call('keyword_remove', { photoIds, keywordId }),
  keywordSetOptions: (id, synonyms, includeOnExport, isPrivate) => call('keyword_set_options', { id, synonyms, includeOnExport, isPrivate }),
  keywordsFor: (photoIds) => call('keywords_for', { photoIds }),
  metadataGet: (photoIds) => call('metadata_get', { photoIds }),
  metadataSet: (photoIds, patch) => call('metadata_set', { photoIds, patch }),
  // On Windows the webview serves custom schemes as http://<scheme>.localhost
  previewUrl: (id, level, version) => `${THUMB}/${id}/${level}?v=${version}&e=${epoch}`,
  developGet: (id) => call('develop_get', { id }),
  developSave: (id, recipe, step) => call('develop_save', { id, recipe, step }),
  renderUrl: (id, recipe, version, edge = 0, overlay, proof) =>
    `${THUMB}/render/${id}?r=${encodeURIComponent(JSON.stringify(recipe))}&edge=${edge}${overlay ? `&overlay=${encodeURIComponent(overlay)}` : ''}${proof ? `&proof=1${proof.gamut ? '&gamut=1' : ''}&pr=${proof.rev}` : ''}&v=${version}&e=${epoch}`,
  proofSet: (path, intent) => call('proof_set', { path, intent }),
  pickProfile: async () => {
    const r = await open({ multiple: false, title: 'Choose a colour profile (.icc or .icm)', filters: [{ name: 'Colour profiles', extensions: ['icc', 'icm'] }] })
    return typeof r === 'string' ? r : null
  },
  developAuto: (id) => call('develop_auto', { id }),
  developFindDust: (id, recipe) => call('develop_find_dust', { id, recipe }),
  developSpotSource: (id, x, y, size) => call('develop_spot_source', { id, x, y, size }),
  presetList: () => call('preset_list'),
  presetCreate: (name, group, groups, recipe) => call('preset_create', { name, group, groups, recipe }),
  presetRename: (id, name) => call('preset_rename', { id, name }),
  presetDelete: (id) => call('preset_delete', { id }),
  snapshotList: (photoId) => call('snapshot_list', { photoId }),
  snapshotCreate: (photoId, name, recipe) => call('snapshot_create', { photoId, name, recipe }),
  snapshotDelete: (id) => call('snapshot_delete', { id }),
  zoomOpen: (id, recipe) => call('develop_zoom_open', { id, recipe }),
  zoomClose: () => call('develop_zoom_close'),
  regionUrl: (id, recipe, x, y, w, h, version) => `${THUMB}/render/${id}?r=${encodeURIComponent(JSON.stringify(recipe))}&zoom=1&x=${x}&y=${y}&w=${w}&h=${h}&v=${version}&e=${epoch}`,
  on: (event, cb) => listen(event, (e) => cb(e.payload as never)),
}

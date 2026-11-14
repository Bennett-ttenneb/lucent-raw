# Lucent Raw: Developer Guide

Version 0.1.0 (written 18 October 2026). For someone who needs to run, change, test or package the program.

Lucent Raw (called Penumbra while it was being built, and LUMORA for a while after) is an offline desktop photo organiser and editor in the style of Lightroom Classic. This guide describes **what the code actually is today**. Three older planning files in the project (`architecture.md`, `backend.md`, `recon.md`) describe the original plan; where they differ from this guide, this guide is right (see "Where the plan and the code differ").

## Contents

1. What it is made of
2. Getting it running
3. Folder map
4. How the pieces talk: one interface, two implementations
5. The Rust core, module by module
6. The catalog (database)
7. The edit pipeline
8. Built-in models
9. The front end
10. Features that need care: previews, sidecars, virtual copies, the AI connection
11. Tests
12. Design system and branding
13. Adding something: a worked recipe
14. Things that will bite you
15. Licences and distribution
16. Packaging and release (not done)
17. Where the plan and the code differ

---

## 1. What it is made of

| Part | What | Notes |
| --- | --- | --- |
| Shell | **Tauri 2** | One window (WebView2 on Windows). Rust process plus a web page. |
| Core | **Rust** (about 17,000 lines in `app/src-tauri/src`) | Catalog, previews, edit pipeline, models, export, books, sidecars, AI connection server. |
| UI | **React 19 + TypeScript + Vite**, **zustand** state, **@tanstack/react-virtual** | Plain CSS with design tokens (no Tailwind in the end). |
| Database | **SQLite** through `rusqlite` (bundled), one folder per catalog | WAL mode, foreign keys on. |
| RAW | **rawler 0.8** (pure Rust) | **LGPL-2.1.** See chapter 15. |
| Other images | `image` crate (JPEG, PNG, TIFF, BMP, WebP), `kamadak-exif` | |
| Models | **tract-onnx** (pure Rust ONNX runtime) with four small models compiled into the program | Not ONNX Runtime (`ort`), which the plan had named. |
| Colour | A small ICC handling module (`colour.rs`) for the export profile tags | The pipeline works in sRGB. |
| XML | `roxmltree` to read sidecar files | Entity expansion off. |
| Tests | `cargo test`, `vitest`, **Playwright** against the browser build | |

Targets Windows 10 and 11 first. Nothing in the code is Windows-only on purpose, but only Windows has been built and run.

## 2. Getting it running

You need: **Node.js** (24 was used), **Rust** (the stable toolchain; builds were done with the release profile), and on Windows the **WebView2** runtime and the Visual Studio C++ build tools that Rust and Tauri need.

From `app/`:

```bash
npm install
npm run dev            # the browser build with the in-memory "mock" core, at http://localhost:1420
npm run tauri dev      # the real program: starts Vite and the Rust core in a window
npm run build          # type-check and build the web part into app/dist
```

The browser build (`npm run dev`) needs no Rust: it uses `mockApi.ts`, a pretend core with 96 seeded photos, so most of the interface can be worked on and tested without the database. **It is not the real program**; it cannot show real photos or write files.

Tests (all from `app/`):

```bash
npx tsc --noEmit           # types
npx vitest run             # unit tests for the front end logic
npx playwright test        # browser tests against the mock core (starts Vite on port 1420)
cd src-tauri && cargo test --release --lib     # the Rust tests
npm run check              # tsc, vitest and playwright together
```

Use `--release` for the Rust tests: several of them decode and process real images and are far too slow in a debug build. A full Rust test run takes about a minute and a half; the full Playwright run takes 12 to 20 minutes on the development machine.

**Starting the real program on a throwaway catalog.** Set `PENUMBRA_CATALOG` to a folder before `npm run tauri dev` and the program uses (and creates) that folder as its first catalog instead of the one in the Windows application data folder. The list of catalogs and the AI connection's settings are kept in that folder's parent. Use this for anything that might damage a catalog.

Other environment variables, all for tests and diagnostics: `PENUMBRA_TIMING` (prints how long a few operations take), `PENUMBRA_BOOK_SAMPLE` (a test writes a sample book PDF to that path), `PENUMBRA_RAW_SAMPLES`, `PENUMBRA_PHOTOS`, `PENUMBRA_EXPORT_SRC` and `PENUMBRA_EXPORT_OUT`, `PENUMBRA_FACE_DIR`, `PENUMBRA_FACE_OUT` (for ignored tests that need real photos or write pictures to look at).

## 3. Folder map

```
replica/                        the project root (a git repository, local only)
  docs/                         these guides
  design/                       design tokens, brand assets, notes
  licences/                     licence texts for the four models, DEPENDENCIES.txt
  THIRD_PARTY.md                what is built on, and the licence notes (read chapter 15)
  build-log.md                  a dated log of every piece of work, what was tried and what was not built
  features.csv, parity.md       the feature list with built / partial / no, and the scored report
  bugs.md, test-plan.md         what was found and fixed, and what the tests cover
  architecture.md, backend.md   the original plan (partly out of date)
  app/
    src/                        React app
      components/               one file per screen area (Library panels, Develop, Book, dialogs ...)
      lib/                      everything that is not drawing: store, api, mock, types, logic and its tests
      styles/                   app.css and tokens.css
    e2e/                        Playwright specs (f01 ... f20)
    public/fonts/               Montserrat
    scripts/sync-tokens.mjs     copies design tokens into the app
    src-tauri/
      src/                      the Rust core (chapter 5)
      migrations/001_init.sql   the catalog schema
      resources/                the four ONNX models
      tauri.conf.json           window, security policy, bundle settings
```

## 4. How the pieces talk: one interface, two implementations

The most important design decision on the front end: **everything the UI needs from the core goes through one TypeScript interface**, `Api`, in `app/src/lib/types.ts` (about 90 methods). There are two implementations:

- `tauriApi.ts`: each method calls a Rust command with `invoke('command_name', { args })`. It also asks for pictures through a custom address, `http://thumb.localhost/{photo id}/{thumb|standard}?v=...&e={epoch}`, which a Rust handler serves from the preview folder (and, if a preview is missing, makes it).
- `mockApi.ts`: an in-memory pretend core, used in the browser and by every Playwright test. `api.ts` chooses between them (the real one when `window.__TAURI_INTERNALS__` exists).

Consequence: **a feature has three halves that must agree**: the Rust command, the `Api` method and its two implementations, and the UI. The browser tests prove the UI against the mock; only the Rust tests prove the core. Nothing automatically proves that the mock behaves like the real core. When you add behaviour, write both, and keep the mock honest (it should refuse the same things and say the same words).

**Events** go from the core to the UI with `app.emit(name, payload)` and `api().on(name, callback)`. The ones in use: `preview:ready` and `preview:progress` (previews), `export:progress`, `enlarge:progress`, `cull:progress`, `book:progress`, `missing:progress`, `xmp:progress`, and `catalog:changed` (something changed the catalog from outside the window, so reload).

**The mock's test switches.** In the browser build, query-string switches change what the mock does so the tests can reach awkward states: `?seed=N` (number of photos), `?longnames=1`, `?fail=1`, `?failpreview=1`, `?nofaces=1`, `?pick=<path>` (what the folder picker returns), `?catalogs=2`, `?mcpfail=1`, `?bookfail=1`, `?corrupt=1`, `?missing=1`, `?xmpforeign=1`, `?xmpfail=1`, `?backupfail=1`. They are read in `api.ts`.

## 5. The Rust core, module by module

`lib.rs` (about 2,300 lines) holds the application state (`AppState`), all the Tauri commands (about 80, each a thin wrapper), the preview protocol handler, and the glue (activating a catalog, the sidecar writer thread, the preview rebuild). The real logic is in modules:

| Module | What it does |
| --- | --- |
| `catalog.rs` | The database: photos, folders, collections (including smart ones), keywords, metadata, develop settings and history, presets, snapshots, books, virtual copies, the missing-file scan and relinking, backup and integrity check, and what goes in a sidecar. The biggest file. |
| `catalogs.rs` | The list of catalogs (`catalogs.json`): add, remove, rename, current. A damaged list gives a list with just the first catalog, so a person is never locked out. |
| `media.rs` | Reading files: decode any supported file, EXIF, RAW (with the camera's embedded preview when big enough), preview building, edited pictures at a given size. |
| `develop.rs` | The **recipe** (all the edits as one structure, JSON in the catalog) and the pipeline that applies it. See chapter 7. |
| `geometry.rs`, `colour.rs` | Lens, transform and crop geometry; the colour spaces and profiles used by export. |
| `masks.rs` | Local adjustments: linear, radial, brush, luminance, colour range, subject, sky, and how they combine. |
| `spots.rs`, `redeye.rs`, `portrait.rs`, `faces.rs` | Clone, heal and fill spots; red eye; skin, eyes and teeth; face detection (YuNet). |
| `subject.rs`, `inpaint.rs`, `upscale.rs` | The U2-Net, MI-GAN and Real-ESRGAN models (chapter 8). |
| `presence.rs` | The Presence sliders: Texture and Clarity (brightness-only local contrast at two sizes), Dehaze (dark-channel haze removal with an airlight estimated from the whole picture, so a 100% view agrees with the whole). Applied in `develop.rs`: dehaze before the tone step, texture and clarity after the masks and before sharpening. Sizes scale with the picture (the reference is 2048 pixels wide). |
| `advisor.rs` | B BOT: skin-tone and exposure advice by trying real adjustments and measuring. Not a trained model. |
| `cull.rs` | Sharpness (variance of a Laplacian over tiles), exposure, burst and near-duplicate grouping (a 64-bit difference hash within 60 seconds). |
| `export.rs` | Formats, sizing, sharpening, watermark, border and caption, names, camera details block, and the preview of an export. |
| `book.rs`, `pdf.rs` | The photo book model and its sanitising, and a hand-written PDF writer (PDF 1.4, Helvetica metrics, JPEG pictures). |
| `xmp.rs` | Reading and writing sidecar files. |
| `smart.rs` | Smart collection rules and their conversion to SQL. |
| `mcp.rs`, `mcp_tools.rs` | The AI connection: a small HTTP server speaking MCP (JSON-RPC), and the nine tools. |

**Locking.** The open catalog is `Arc<Mutex<Option<Catalog>>>`, used through `AppState::with(|catalog| ...)`. Keep the closure short, never hold it across a slow operation (decoding a picture, writing a file), and never call `with` inside another `with`. Long work (`spawn_blocking`, worker threads) takes what it needs, releases the lock, works, and takes it again to store the result. The previews folder is a separate lock.

**Commands are thin.** A command should validate, call a module, and shape the answer. New logic belongs in a module with its own tests; `lib.rs` has a few orchestration functions (sidecar writing and reading, preview rebuilding, the AI connection's wiring) that are tested through `AppState` in `catalog_tests`.

## 6. The catalog (database)

One catalog is **a folder** holding `catalog.db` (SQLite) and a `previews` folder. There is no user table: it is a local single-user file. The schema is `src-tauri/migrations/001_init.sql` (26 tables and a search table). Facts to know:

- **Folders are a root plus a relative path** (`root_folder.absolute_path`, `folder.rel_path`), so a moved drive is one update. A photo's file is `root/rel/base_name.ext`.
- **Edits are data, not pixels.** `develop_settings.settings_json` is the full recipe, with a `process_version`. `history_step` rows keep a recipe per step (the list is limited to the newest 500 per photo).
- **Photos have `metadata_dirty`**, set by any change to rating, flag, label, keywords, text or edits. The sidecar writer uses it; it is cleared when a sidecar is written or read.
- **Virtual copies** are `photo` rows with `master_id` set. They copy the original's folder, file name, EXIF row, text, keywords, collections and recipe at creation, and share the file. Deleting the master cascades to its copies.
- **A `book` table** (id, name, json, updated) is created on open if missing (`create table if not exists`), so older catalogs gain it without a migration.
- **`catalog_meta`** holds `schema_version`, `catalog_uuid`, `last_backup` and `xmp_auto`.
- **Migrations.** Only `001_init.sql` exists and it runs only on an empty catalog. **There is no migration runner for a future schema change.** The book table is the one exception (made on open). Before any schema change ships, a runner using `schema_version` must be written.
- **Queries.** The photo list is built by `Catalog::build_where(&self, &Query)` from a `Query` struct (filters, sort, page). A smart collection is resolved inside it. Every value is bound; the only SQL text built from names comes from fixed lists (the column names in metadata updates, the table names in the virtual-copy copier, the column allow-list in smart rules).

The catalog identifier in `tauri.conf.json` is still `app.penumbra.dev` and the browser-side saved settings still start with `penumbra.` on purpose: changing the identifier would move the application data folder, so an existing catalog would appear lost. Leave them.

## 7. The edit pipeline

`develop.rs` holds `Recipe`, one structure with every edit (white balance, tone, tone curve, colour mixer, detail, effects, lens geometry and crop, spots, red-eye, portraits, masks) and `render(img, recipe)`. The order is fixed:

1. geometry (lens, transform, crop), at full size;
2. spots (clone, heal, fill), at full size, then red-eye, then portraits;
3. dehaze;
4. global tone, in a fixed order;
5. local masks;
6. texture and clarity;
7. detail (sharpening, noise reduction);
8. effects (vignette, grain).

It runs **on the CPU**, on all cores, in Rust. The plan had a WebGPU pipeline; that was not built. Live editing works on a 1,100 pixel proxy of the photo (about 46 ms per slider step was measured), and 100% zoom works on a crop of the full-size picture, kept in `AppState.full`. Export processes the full-size picture.

A recipe is `#[serde(rename_all = "camelCase", default)]` throughout: a recipe saved by an older version loads with defaults for fields added later. **Keep it that way** (every new field needs a default and a sanitising rule in `sanitized()`), or old catalogs will fail to load their edits. A recipe equal to the default is stored as no row at all (the photo counts as unedited).

## 8. Built-in models

Four small ONNX models are in `src-tauri/resources/` and compiled into the program with `include_bytes!` (about 38 MB in all) and run with `tract-onnx`, offline:

| File | Model | Used for | Licence |
| --- | --- | --- | --- |
| `face_detection_yunet_2023mar.onnx` | YuNet | finding faces | MIT |
| `realesr-general-x4v3.onnx` | Real-ESRGAN general x4 v3 | AI enlargement (96 pixel tiles with 16 pixels of overlap, 4 times, then resampled) | BSD-3-Clause |
| `u2netp.onnx` | U2-Net (small) | subject and background masks (320 x 320 input; the map is kept in the mask as a 128 x 128 PNG) | Apache-2.0 |
| `migan-512-generator.onnx` | MI-GAN 512 | spot Fill (a 512 x 512 window around the spot; results are cached) | MIT |

Their licence texts are in `licences/` and notes in `THIRD_PARTY.md`. `models-pending/` (untracked) holds the downloaded originals and a README.

**To add or replace a model:** put the file in `resources/`, read its licence first, add a module with a test that runs it on a tiny input and checks the output shape, and record it in `THIRD_PARTY.md`. Ask before downloading anything.

## 9. The front end

- **State** is zustand: `store.ts` (library, selection, filters, dialogs' open flags), `develop.ts` (the open photo's recipe, history, undo, tools), `book.ts` (books and the open book, with autosave), plus small preference stores (`sliderPrefs.ts`, `cropPrefs.ts`, `prefs.ts`). Preferences use `localStorage` through try/catch: storage can be unavailable, and every use must still work without it.
- **Pages of photos.** The library holds pages of 200 rows from the core (`PAGE` in `store.ts`) and asks for more as the grid or filmstrip scrolls (virtualised with TanStack Virtual). A selection can be larger than what is loaded: "select all" asks the core for every id (`photo_ids`, at most 200,000).
- **Stale pictures.** Picture addresses carry a version (`previewVersion` and a per-photo version) and an **epoch** number that changes when the catalog changes, because photo numbers restart at 1 in every catalog and the browser would otherwise show another catalog's cached picture.
- **Dialogs** use the native `<dialog>` through `Primitives.tsx` (`Dialog`, `Panel`, `ProgressBar`). Every dialog has an accessibility scan in its test.
- **Modules** are the tabs: `ModuleId` in `store.ts`; the tab list is `MODULES` in `Bars.tsx`; the routing is in `App.tsx`. Map, Slideshow, Print and Web exist as ids with a "coming later" screen but their tabs are hidden.
- **Keyboard**: `useShortcuts` in `App.tsx` and `keys.ts`. Shortcuts are ignored when typing in a field or when a dialog is open.
- **Wording.** Text a person reads is plain and says what happened and what to do. Errors from the core are written as sentences ("That folder is not there."), because they are shown as they come.

## 10. Features that need care

**Previews.** Every photo has `{id}_thumb.jpg` and `{id}_standard.jpg` (the untouched base, which Develop and the tools start from) and, if edited, `{id}_ethumb.jpg` and `{id}_estandard.jpg` (the edited look). The base ones must never be overwritten by an edit. They are built after import by worker threads and announced with `preview:ready`. A preview that is missing is **made on demand** by the preview handler (one at a time, under `build_lock`, so a screen of missing pictures cannot use all the memory) and by `base_preview()` for every tool that reads the base. Preferences can clear them all safely because of this.

**Sidecar files (XMP).** `xmp.rs` writes `name.xmp` beside RAW files and `name.ext.xmp` beside others. It uses Adobe names for what has them and the namespace `http://ns.lucentraw.app/1.0/` (`lucent:`) for the pick flag and the edits. **A sidecar without the `lucent:` marker is never overwritten.** Reading is additive for keywords and edits. A background thread (`start_xmp_writer`) writes changed photos every few seconds when the setting is on; after a failure it waits a minute. Virtual copies never use sidecars.

**Virtual copies.** See chapter 6. Remember that copies share a file: anything that matches photos by file (the relink search, sidecars, the missing scan) must treat copies specially. Each of those places does today; a new feature that does something per file needs the same care.

**The AI connection (MCP).** `mcp.rs` is a minimal HTTP server (`POST /mcp`, JSON-RPC, the 2025-06-18, 2025-03-26 and 2024-11-05 protocol versions). Rules that must not be loosened: **off by default; 127.0.0.1 only; a bearer token on every request, compared in constant time; any request with an `Origin` header or a non-local `Host` is refused (403); bodies over 1 MB, calls over 10 seconds and more than 8 connections are refused.** It starts at port 47321 and takes the next free one up to 20 further. The nine tools (`lucent_raw_status`, `list_catalogs`, `find_photos`, `get_photo_edit`, `set_marks`, `adjust_photo`, `suggest_edits`, `cull_photos`, `export_photos`) are in `mcp_tools.rs`; only the last three of the writers change anything and none delete or alter an original. **Do not add a tool that deletes, removes photos, switches catalogs or overwrites files.** Text from photos (names, captions, keywords) is returned as data and the server's instructions say so. Settings and the token are in `mcp.json` beside the catalog list.

**Books.** The book model (`book.rs`) is sanitised on every save (200 pages, 12 frames, clamped numbers, hex colours, text length). Rendering to PDF loads each photo as edited at about 300 dots per inch (at most 3,200 pixels), and a photo that cannot be loaded becomes a grey box and a warning.

## 11. Tests

| Kind | Where | What it proves | Count (18 Oct 2026) |
| --- | --- | --- | --- |
| Rust | in each module (`#[cfg(test)]`) and `catalog_tests` in `lib.rs` | the core: catalog, pipeline, models, PDF structure, sidecars, backup, smart rules ... | 317 passing, 9 ignored (need real photos or write files for looking at; `PENUMBRA_RAW_DIR=<folder>` with the ignored test `raw_files_in_a_folder_are_read_or_say_why_not` tries every RAW file in a folder) |
| Unit | `app/src/lib/*.test.ts` (vitest, jsdom) | front end logic: shortcuts, filters, recipes, curves, masks, presets, prefs | 276 |
| Browser | `app/e2e/f01 ... f21` (Playwright with Edge, against the mock) | the interface: flows, keyboard use, error messages, accessibility scans (axe) | 359 |

Conventions: Playwright specs use roles and labels, never CSS classes; every dialog or new screen gets an axe scan; the mock switches (chapter 4) reach failure states. The browser tests do **not** run the real core, and no automated test drives the real window.

**Known flakiness.** Many parallel browsers on the development machine sometimes time out; `retries: 1` is set so a test that fails once and passes is reported "flaky" and a real fault still fails twice. Axe scans are the usual slow ones. **Do not edit front-end source while a test run is going**: it makes results meaningless. Start the Vite server first and let it warm up. If a run shows a few failures, run just those again before believing them.

**What has never been tested:** the real window with the real core end to end (only the core's own tests and the mock UI tests exist); Claude Code connected to the AI connection; RAW files from most camera makers; the Book PDF in a printer's workflow; any machine other than the development one.

## 12. Design system and branding

**Light and dark.** The colours are CSS variables. Dark is the default and lives in `tokens.css` (generated); the light palette is `app/src/styles/theme-light.css`, switched on by `data-theme="light"` on `<html>` (`lib/theme.ts`; the choice is dark, light or system, saved as `penumbra.theme`). The light colours are in their own file because `npm run tokens` overwrites `tokens.css`. Colours drawn over photos (crop lines, mask lines, face numbers) stay white with a dark halo (`--color-halo`) in both themes. Both themes are checked by axe scans (`e2e/f22-theme.spec.ts`); when you add a colour, add it to both. `design/tokens.json` does not know about the light palette yet.

Colours: Obsidian `#080D12`, Electric Blue `#8496FF`, Soft White `#F5F6FC`. Font: Montserrat (in `public/fonts`). Shapes: rounded (radius tokens xs 6, sm 8, md 12, lg 20, xl 28, pill). Tokens live in `design/tokens.json`; `npm run tokens` (`scripts/sync-tokens.mjs`) writes `design/tokens.css` and `app/src/styles/tokens.css`; `app.css` has one marked block, "LUMORA shape language", at the end that holds the rounded look. The name in the interface is **Lucent Raw**; the mark (an "L" drawn as a folded ribbon) and the wordmark (`Logo.tsx`; the A of RAW is drawn without its crossbar) are code. Logo files (SVG and PNG, for dark, light and Obsidian backgrounds) are in `Desktop/Lucent Raw brand assets` and were made by script from the original LUMORA ones; the old LUMORA folder was left alone. Contrast matters: dark theme text and accent colours are checked by the axe scans, and several earlier fixes were to colour pairs that failed.

## 13. Adding something: a worked recipe

Say you want a new action "Do X to the selected photos".

1. **Core.** Write the logic in the right module (or a new one, declared with `mod x;` at the top of `lib.rs`) with unit tests that use real files in a temporary folder. If it touches the catalog, add a method on `Catalog` and test it with the `imported()` helper in `catalog.rs`'s tests.
2. **Command.** In `lib.rs`, add `#[tauri::command] fn do_x(state: tauri::State<'_, AppState>, ids: Vec<i64>) -> Result<..., String>` and list it in `generate_handler![...]`. For slow work use `async` with `spawn_blocking` and emit a progress event.
3. **Interface.** Add the method to `Api` in `types.ts`, the call in `tauriApi.ts`, and a behaving version in `mockApi.ts` (refuse the same things, say the same words, and add a switch in `api.ts` if the tests need a failure).
4. **UI.** Add the component or button; put the open flag for a dialog in `store.ts`; mount a dialog in `App.tsx`. Use roles and labels so it can be tested.
5. **Tests.** A Playwright spec (happy path, a refusal, keyboard use, an axe scan) and the unit test for any pure logic.
6. **Docs.** An entry in `build-log.md` (what, why, what was not built), the row in `features.csv`, and the sentences in the user guide.
7. Run `tsc`, vitest, the specs you touched, then the whole Rust and Playwright suites before committing.

Commits are local only. The commit author is set on the command line (`git -c user.name=... -c user.email=...`); nothing has ever been pushed. If it is ever put on GitHub: use a **private** repository, and leave out the folders `screens/` and `clone-screens/` (screenshots of the other program) and `models-pending/`.

## 14. Things that will bite you

- **Windows paths and quoting in scripts.** The development shell is Git Bash; here-documents containing backslashes or quotes have broken several times. Write scripts with the editor tool, not with `cat <<EOF`.
- **`python` is not installed** (Windows redirects it to the Store). The two Python tools of the parity skill have been ported to Node.
- **Rust builds** were once blocked entirely by a Defender attack-surface rule; it is now working. If builds hang or fail with access errors on a new machine, suspect antivirus first.
- **Do not run a Rust build while a browser test run is going**; both slow down and tests time out.
- **Stale browser caches.** If a preview looks wrong after a catalog change, check the epoch handling before suspecting the core.
- **Serialisation names.** The core uses `camelCase` in JSON, enums as lowercase strings; a mismatch with `types.ts` fails silently (a field is just missing). The unit test `the_starting_settings_are_the_ones_the_page_starts_with` guards the export settings; add similar guards when two sides must agree on defaults.
- **Time.** The camera's capture time is kept as local text with no zone (`captured_local`), because most cameras write none. Do not "fix" it by converting.
- **The mock and the core drift.** Re-check after each core change that the mock still says the same words.

## 15. Licences and distribution

Read `THIRD_PARTY.md` and `licences/DEPENDENCIES.txt` (all 529 Rust libraries with their licences, made from the build on 18 October 2026) before the program is shared or sold. In short:

- Almost everything is MIT, Apache-2.0 or BSD: only a notice is needed.
- **`rawler` is LGPL-2.1** and is built into the program. Distributing it needs a decision: comply with the LGPL (give recipients a way to rebuild the program with a changed `rawler`, for example by offering the source), release the app as open source, or replace RAW reading. **This is undecided, and the first thing to settle before distribution.** It is not legal advice; get proper advice.
- Five MPL-2.0 libraries (from Tauri's web tools: `option-ext`, `selectors`, `cssparser`, `cssparser-macros`, `dtoa-short`) are used unchanged and need a notice and a pointer to their source.
- The four models' licence texts are in `licences/`. The **npm (JavaScript) libraries have not been audited** for licences yet; `npm ls --omit=dev` lists them and they are mostly MIT.
- The licence texts for MIT, Apache-2.0, BSD-3-Clause, LGPL-2.1 and MPL-2.0 themselves, and a screen or file that shows them, still need adding to what is shipped.

## 16. Packaging and release

An unsigned NSIS installer (per user, no administrator rights) has been built, many times (the tester installers are in `installer/`). It is made with `npm run tauri build -- --bundles nsis` on a normal Windows development machine. On a Windows machine where an IT policy stops freshly built executables from running (as on the laptop this work was moved to), cargo cannot run at all; build in WSL instead:

1. In Windows: `npm run build` in `app/` (makes `app/dist`).
2. In WSL (Ubuntu): install `build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev nsis llvm clang lld`, Rust (`rustup`), the target `x86_64-pc-windows-msvc`, and `cargo install --locked cargo-xwin tauri-cli`.
3. Copy `app/` (without `node_modules`) to the Linux side, then in `src-tauri`: `XWIN_ACCEPT_LICENSE=1 cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis --config '{"build":{"beforeBuildCommand":""}}'`. The installer is under `target/x86_64-pc-windows-msvc/release/bundle/nsis/`.

The Rust tests run in the same Linux copy (`cargo test --lib`; one test needs a case-insensitive file system and is skipped there). Code that only exists on Windows (free space, memory cards, the display profile, the Recycle Bin) is type-checked with `cargo xwin check --lib --target x86_64-pc-windows-msvc` but has not been run against a real card, monitor or Recycle Bin.

Still not done:

- Code signing (a certificate has to be bought), an updater (the program never updates itself, by choice), crash reporting and a first-run screen. An unsigned installer shows a Windows SmartScreen warning.
- Checking the preview address (a custom protocol; the content security policy allows `http://thumb.localhost`) in a built copy on a computer that has run an installer.
- macOS and Linux have never been built as programs (the Linux copy is only used to compile and test the Rust).
- The application identifier (`app.penumbra.dev`) is kept so existing catalogs are found; changing it moves the data folder.
## 17. Where the plan and the code differ

`architecture.md` and `backend.md` were written first. Today the code differs in these ways:

| Plan | What was built |
| --- | --- |
| WebGPU edit pipeline in the webview, one shader source for live preview and export | A CPU pipeline in Rust on all cores. |
| `ort` (ONNX Runtime) for models | `tract-onnx`, pure Rust, models compiled in. |
| Tailwind for styling | Plain CSS with design tokens. |
| TanStack Query over IPC | zustand and direct calls. |
| `quick-xml` for XMP | `roxmltree` to read, hand-written text to write. |
| `printpdf` for books | A small PDF writer written for this program. |
| A job table for crash-safe background work | Threads and events; the table exists in the schema but is not used. |
| A workspace of several Rust crates | One crate with modules. |
| "The Rust core has never been compiled" (`backend.md`) | It compiles, and has 306 passing tests. |
| LibRaw or `rawler` | `rawler` (LGPL-2.1, see chapter 15). |
| Map, Slideshow, Print, Web, Plugin SDK, cloud sync | Left out on purpose. |

Keep this guide up to date when you change any of the above; the older files are history.

# Component specs

Measured from `replica/screens/` (o) or inferred (k). Sizes are CSS px at 100% scale and are approximations: the screenshots are 1919 px wide and the OS scale factor is unknown. All colours are token roles from `tokens.json`; never raw hex. Dark UI only for v1, with a light/dark canvas level setting later.
Icons: an open set (Lucide, MIT) in the product, never the original's glyphs. The showcase page uses a few simple hand-drawn SVG shapes as stand-ins.
Copy: every label is written fresh in /replica-brand. Labels in this file are placeholders that name the job.
Keyboard: every control reachable by Tab, activated by Enter/Space, with a visible 2 px `accent` focus ring on `chrome` or `surface` (both pass 3:1). Never colour alone: states use a shape or text as well.

## Shell

```
AppShell (S02)
  layout    grid: module-bar (56) / main / filmstrip-bar (32) / filmstrip (150); main = left-panel (290) | centre | right-panel (275)
  regions   left and right panels collapse to a 12px edge handle; top and bottom edges collapse the module bar and filmstrip
  states    panels hidden, filmstrip hidden, full screen, dim, lights out (k)
  tokens    bg chrome, panel surface, divider border (1px black)
  a11y      landmarks: banner, navigation (modules), main, complementary (panels); F5-F8 style shortcuts toggle regions
  used on   all

ModulePicker
  variants  text tabs separated by a thin vertical rule
  states    default text-muted, hover text, active text-on-canvas (white) with no underline, focus-visible ring, disabled
  tokens    module 17/24, bg chrome
  a11y      role=tablist; arrow keys move, Ctrl+Alt+1..7 switch module
  used on   S02

IdentityPlate
  parts     small app mark + name + optional user name with dropdown; progress bar replaces name during long jobs (S12, S29)
  states    idle, busy (determinate/indeterminate, cancel x), error toast
  a11y      progress has aria-valuenow and a live-region label

MenuBar
  variants  menus change per module (o): File Edit [Module] Photo ... Window Help
  states    open, hover, disabled item, checked item, submenu, shortcut hint right-aligned
  a11y      role=menubar, Alt opens, arrow navigation
```

## Panels

```
Panel (group of sections)
  variants  left group, right group
  tokens    bg surface, section divider border
  behaviour sections collapse; Alt-click = solo mode (only one open); drag header to reorder (k)

PanelHeader
  height    28
  tokens    bg surface-header, text panel 15/20, triangle disclosure icon, optional action (+, x, eye toggle)
  states    expanded, collapsed, hover, focus-visible, dragging
  a11y      real <button aria-expanded>, action buttons labelled
  used on   S08, S09, S15, S16, S43

PanelSection
  tokens    padding 8, row gap 4
  states    empty (shows a one-line hint), loading, disabled when no photo selected
```

## Controls

```
Button
  variants  default (surface-raised), subtle (text only, for toolbar), accent (primary, rare), danger
  sizes     sm 22px, md 28px (panel footer: Import, Export, Previous, Reset: full-width pair)
  states    default, hover, active, focus-visible, disabled (text-disabled), loading (keeps label, shows spinner)
  tokens    bg surface-raised, text, radius sm, text base
  used on   S03 (Import, Export), S14 (Copy, Paste, Previous, Reset), S24

IconButton
  sizes     22, 28; always has aria-label and tooltip
  states    default, hover, pressed (toggle), focus, disabled
  used on   toolbars, tool strip, filmstrip bar

ToolStrip (Develop) (o)
  items     edit, crop, remove, red-eye, masking, one more; icon row, active tool underlined with accent, a dot under tools that have edits
  a11y      role=toolbar, roving tabindex

Slider (the most-used control)
  anatomy   label (muted, left), track with handle, value field (right, tabular numerals)
  variants  centred (zero in the middle, e.g. Exposure), one-sided (0..max), gradient track (Temp, Tint, Hue, Saturation), disabled
  states    default, hover (handle grows), drag (value highlighted, fine control with Shift), focus-visible, modified (label turns text, small dot), disabled
  behaviour double-click label or handle resets to default; click value to type; arrow keys step 1, Shift+arrow step 10; scroll over value nudges
  tokens    track surface-input, handle text-muted -> text, radius pill, label sm/text-muted, value sm/text
  a11y      role=slider, aria-valuenow/min/max, aria-valuetext uses the locale format (comma decimals seen (o))
  used on   S09 (Quick Develop), S16, S18, S25 to S27

NumericField
  states    default, focus (accent underline), invalid (danger + message), disabled
  behaviour locale-aware input and display; stores numbers, never strings

Select / Dropdown
  variants  inline small (preset pickers (o)), full-width
  states    default, open (listbox), hover, focus, disabled
  a11y      native <select> or Radix Select; type-ahead

Checkbox / Switch
  variants  check, tri-state (indeterminate, used in preset trees), eye toggle for panel on/off (o)
  states    all plus focus and disabled

TextField / SearchField
  variants  filter box with magnifier (o: Filter Folders, Filter Collections, Search Map)
  states    default, focus, has-value with clear x, disabled

StarRating
  variants  5 stars in filmstrip bar (o), on cells, in Metadata
  states    unset, hover preview, set, mixed (selection with different values: dim)
  keyboard  0..5 sets; same key again toggles to 0
  a11y      role=radiogroup, "3 of 5 stars"

FlagControl (pick, reject, none) / ColourLabelChips
  chips     red, yellow, green, blue, purple (+ none); each has a letter or shape so it is not colour-only
  keyboard  P, X, U, 6 to 9
  tokens    label-* roles (graphics only; not used for text)

Tooltip
  delay 600ms, bg chrome, text sm, shows shortcut

Toast (on-canvas message)
  variants  info, success, error; fades after 1.5s; aria-live=polite

Dialog
  variants  modal (Import, Export, Preferences, Settings), small confirm
  anatomy   title bar, body, footer buttons right-aligned, primary rightmost
  states    default, busy, error
  a11y      focus trap, Esc closes unless busy, returns focus, aria-labelledby
  tokens    bg surface, shadow pop, radius md
```

## Library

```
FilterBar (S10) (o)
  tabs      Text, Attribute, Metadata, None; panel of controls under the active tab
  extras    lock icon, saved filter dropdown ("Filters Off")
  states    inactive (None), active (accent underline), no results

ThumbnailGrid (S03)
  variants  compact, expanded (with info rows), square or aspect cells, cell size slider
  behaviour virtualised; keyboard arrow navigation; Shift/Ctrl multi-select; drag to collections; large index number behind each cell (o) optional
  states    empty catalog (empty state with an Import call to action), loading previews (placeholder tone), filtered to nothing
  a11y      role=grid, aria-rowcount, cells aria-selected, live count "298 photos, 1 selected"

ThumbnailCell
  parts     image, index number, badges (develop-modified, cropped, in collection, stack count, virtual copy, metadata unsaved), rating stars and flag (shown in expanded mode and on hover), label tint
  states    default, hover (cell-hover), selected (cell-selected + 2px ring), active (primary of selection, brighter), dragging, missing (exclamation badge and dim), loading
  tokens    bg cell, selected bg cell-selected, badge bg chrome 70%
  note      selection needs more than colour: ring plus a bolder bg

Filmstrip (o)
  parts     bar (source label "Previous Import 298 photos / 1 selected / name", filters, stars, labels) + strip of cells
  states    collapsed, scrolling, drag reorder in a collection

TreeView
  used on   Folders, Collections, Keyword List, Import destination
  parts     disclosure, icon, label, count (right, muted), optional bar (volume free space (o))
  states    collapsed, expanded, selected, drop-target, renaming, offline (muted with a warning icon)
  a11y      role=tree, arrow keys, type-ahead

Histogram
  parts     canvas drawing R, G, B and luminance, clipping triangles top corners (o), EXIF line below (o), "Original Photo" toggle (o)
  states    no photo (flat), clipped shadows/highlights on (highlight colours clip-shadow / clip-highlight), hover zone highlight when editing
  a11y      role=img with text alt "Histogram, shadows clipped 2%" (not colour-only)

MetadataPanel
  parts     preset dropdown, view switcher ("Default"), key/value rows, fields editable, Target Photo vs Selected Photos tabs (o)
  states    single, multi with mixed values (shows <mixed> placeholder), read-only (offline file), has been changed
  behaviour Sync Metadata button

KeywordEditor
  parts     chip input with autocomplete, suggestions, keyword set picker

AssistedCullingPanel (o)
  parts     rows: Subject Focus, Eye Focus, Eyes Open, Faces with overlay toggle, status line, feedback link
  states    disabled (no analysis yet), computing (progress), "No faces found", scores shown as a small bar plus text
```

## Develop

```
ImageCanvas
  modes     fit, fill, 1:1, zoom with pan, before/after (left-right, top-bottom, split)
  overlays  info overlay with file name and capture info (o, overlay 20/26, text-on-canvas), crop grid, mask overlay, spot circles, loupe
  states    loading (proxy then sharpen), error (unsupported file with a message), empty (no photo)
  a11y      canvas has an aria-label with the photo name; edits are announced via the panel controls
  tokens    bg canvas (user-adjustable grey level), text-on-canvas with a 1px text shadow for legibility

HistoryList (o)
  rows      step name, delta (small, muted), new value (right); current step highlighted; click to travel; clear x in header
  states    empty, long list scrolls, hover

PresetList
  parts     groups (collapsible), user vs built-in, hover preview in Navigator, apply on click, Amount slider (o in Navigator)

SnapshotList
  parts     name, create +, delete on hover, click to apply

ColourProfilePicker (o)
  parts     current profile dropdown plus grid browser button, thumbnail previews of the profile applied

ToneCurve
  parts     canvas with points, channel tabs (RGB, R, G, B), parametric sliders under
  states    hover point, drag, add and remove point (double-click), reset
  a11y      points focusable; arrow keys nudge; value readout

HslGrid / ColourGrading wheels
  parts     8 hue rows or 3 wheels, each with hue, sat, lum

CropOverlay, MaskOverlay, SpotMarker
  states    selected, hovered, being drawn; handles are 8+px with a 24px hit area

MaskList (S18)
  rows      mask name, type icon, show overlay, delete; combine operations Add, Subtract, Intersect; invert
  states    computing (AI), none found, too many (k)
```

## Output modules

```
MapCanvas
  states    tiles loaded, **offline / no tiles (o)** (shows a message and last known area, never blank), no photos with GPS
  parts     pins (selected, unselected, group at same location, cluster, search result (o legend)), zoom slider, map style dropdown, lock, tracklog button
  tokens    pin colours use select and a distinct orange role (add in brand step); pins also differ by shape

LocationFilter bar (o): Visible On Map, Tagged, Untagged, None, search

PageSpread (Book) (o)
  parts     two-page spread tile with page numbers, selected spread ringed with select, drop zones for photos, cover vs inside pages
  states    empty page, filled, overflowing text, selected

TemplateBrowser (Slideshow, Print, Web): grouped list with small previews, user vs built-in
```

## Status of these specs

Seen in screenshots (o): shell, module picker, panels and headers, sliders, tool strip, history, navigator, filter bar, grid and cells, filmstrip and its bar, tree views, histogram, metadata panel, map states and legend, book page spreads and settings. Everything else is (k) and needs a screenshot or a decision before build: Import dialog, Export dialog, masking panel, loupe overlays, Preferences, Slideshow, Print, Web.

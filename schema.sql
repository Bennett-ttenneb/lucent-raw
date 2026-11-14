-- Catalog schema (SQLite). One catalog = one .db file, so there is no catalog_id or user_id column.
-- Deviations from the web template, on purpose:
--   * integer primary keys (fast on 100k+ rows) plus a uuid on photos for catalog merge
--   * no owner column or row level security: single user, local file. Access rule = the OS file permissions.
--   * times are UTC ISO-8601 text; capture time also keeps the camera's local clock and offset
-- Always: PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;

create table catalog_meta (
  key text primary key,
  value text not null
);
-- rows: schema_version, app_version, created_at, catalog_uuid, settings_json

create table root_folder (
  id integer primary key,
  absolute_path text not null unique,
  name text not null,
  volume_id text,                       -- OS volume serial, to detect a moved drive
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table folder (
  id integer primary key,
  root_folder_id integer not null references root_folder(id) on delete cascade,
  parent_id integer references folder(id) on delete cascade,
  rel_path text not null,               -- '' for the root itself, forward slashes
  unique (root_folder_id, rel_path)
);
create index folder_parent on folder(parent_id);

create table import_session (
  id integer primary key,
  started_at text not null,
  finished_at text,
  source text,
  mode text not null check (mode in ('copy','move','add','copy_dng')),
  develop_preset_id integer,
  metadata_preset_id integer,
  photo_count integer not null default 0
);

create table stack (
  id integer primary key,
  collapsed integer not null default 1 check (collapsed in (0,1))
);

create table photo (
  id integer primary key,
  uuid text not null unique,
  folder_id integer not null references folder(id) on delete restrict,
  base_name text not null,
  ext text not null,
  format text not null check (format in ('raw','dng','jpeg','tiff','png','heic','psd','video','other')),
  file_size integer not null,
  file_mtime text not null,
  file_hash text,                       -- fast content hash, used for duplicate detection
  master_id integer references photo(id) on delete cascade,  -- set on virtual copies
  copy_name text,
  stack_id integer references stack(id) on delete set null,
  stack_pos integer,
  import_id integer references import_session(id) on delete set null,
  captured_local text,                  -- camera clock, no zone
  captured_offset_min integer,
  captured_utc text,
  rating integer not null default 0 check (rating between 0 and 5),
  flag integer not null default 0 check (flag in (-1,0,1)),  -- -1 reject, 1 pick
  color_label text check (color_label in ('red','yellow','green','blue','purple')),
  width integer, height integer,
  orientation integer,
  missing integer not null default 0 check (missing in (0,1)),
  metadata_dirty integer not null default 0 check (metadata_dirty in (0,1)),  -- sidecar out of date
  added_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (folder_id, base_name, ext, copy_name)
);
create index photo_folder on photo(folder_id);
create index photo_captured on photo(captured_utc);
create index photo_rating on photo(rating);
create index photo_flag on photo(flag);
create index photo_color on photo(color_label);
create index photo_master on photo(master_id);
create index photo_stack on photo(stack_id);
create index photo_import on photo(import_id);
create index photo_hash on photo(file_hash);

create table exif (
  photo_id integer primary key references photo(id) on delete cascade,
  make text, model text, lens text, serial text,
  iso integer, aperture real, shutter_s real, focal_mm real, focal_35mm real,
  exposure_bias real, flash integer, metering text, wb_mode text,
  gps_lat real, gps_lon real, gps_alt real, gps_dir real,
  raw_json text                         -- everything else, for the metadata panel
);
create index exif_camera on exif(make, model);
create index exif_lens on exif(lens);
create index exif_iso on exif(iso);
create index exif_gps on exif(gps_lat, gps_lon);

create table iptc (
  photo_id integer primary key references photo(id) on delete cascade,
  title text, caption text, creator text, copyright text, credit text, source text,
  sublocation text, city text, state text, country text, iso_country text,
  extra_json text
);

create table keyword (
  id integer primary key,
  name text not null,
  parent_id integer references keyword(id) on delete cascade,
  synonyms text,                        -- comma separated
  include_on_export integer not null default 1,
  export_parents integer not null default 1,
  is_private integer not null default 0,
  unique (parent_id, name)
);
create index keyword_parent on keyword(parent_id);

create table photo_keyword (
  photo_id integer not null references photo(id) on delete cascade,
  keyword_id integer not null references keyword(id) on delete cascade,
  primary key (photo_id, keyword_id)
);
create index photo_keyword_kw on photo_keyword(keyword_id);

create table collection (
  id integer primary key,
  name text not null,
  parent_id integer references collection(id) on delete cascade,
  kind text not null check (kind in ('collection','smart','set','quick','book','slideshow','print','web')),
  rules_json text,                      -- smart collections only
  is_target integer not null default 0 check (is_target in (0,1)),
  output_settings_json text,            -- book/slideshow/print/web layouts and options
  sort_key text
);
create index collection_parent on collection(parent_id);
create unique index collection_one_target on collection(is_target) where is_target = 1;
create unique index collection_one_quick on collection(kind) where kind = 'quick';

create table collection_photo (
  collection_id integer not null references collection(id) on delete cascade,
  photo_id integer not null references photo(id) on delete cascade,
  position integer not null default 0,
  primary key (collection_id, photo_id)
);
create index collection_photo_photo on collection_photo(photo_id);

-- Develop. settings_json is the full recipe, versioned by process_version. Heavy parts
-- (masks, brush strokes, heal spots) live in develop_blob so list queries stay small.
create table develop_settings (
  photo_id integer primary key references photo(id) on delete cascade,
  process_version integer not null,
  settings_json text not null,
  has_masks integer not null default 0,
  has_crop integer not null default 0,
  edited_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index develop_edited on develop_settings(edited_at);

create table develop_blob (
  id integer primary key,
  photo_id integer not null references photo(id) on delete cascade,
  kind text not null check (kind in ('mask_bitmap','brush_path','heal_source','ai_cache')),
  data blob not null,
  hash text not null
);
create index develop_blob_photo on develop_blob(photo_id);

create table history_step (
  id integer primary key,
  photo_id integer not null references photo(id) on delete cascade,
  seq integer not null,
  label text not null,                  -- 'Temperature'
  delta_text text,                      -- '-300'
  value_text text,                      -- '5,5K' (display only, formatted in the UI by locale)
  patch_json text not null,             -- forward and reverse patch, not full settings
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (photo_id, seq)
);

create table snapshot (
  id integer primary key,
  photo_id integer not null references photo(id) on delete cascade,
  name text not null,
  settings_json text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index snapshot_photo on snapshot(photo_id);

create table preset (
  id integer primary key,
  type text not null check (type in ('develop','metadata','export','import','watermark','filename','print_template','slideshow_template','web_template','book_template','filter','color_profile')),
  name text not null,
  group_name text,
  settings_json text not null,
  is_builtin integer not null default 0,
  is_adaptive integer not null default 0,
  sort_key text,
  unique (type, group_name, name)
);
create index preset_type on preset(type);

create table preview (
  photo_id integer not null references photo(id) on delete cascade,
  level text not null check (level in ('thumb','standard','full')),
  path text not null,                   -- relative to the previews cache folder
  edit_stamp text not null,             -- must equal develop_settings.edited_at or it is stale
  width integer, height integer, bytes integer,
  last_used text,
  primary key (photo_id, level)
);
create index preview_lru on preview(last_used);

create table smart_preview (
  photo_id integer primary key references photo(id) on delete cascade,
  path text not null,
  width integer, height integer, bytes integer
);

create table person (
  id integer primary key,
  name text
);
create table face (
  id integer primary key,
  photo_id integer not null references photo(id) on delete cascade,
  person_id integer references person(id) on delete set null,
  x real not null, y real not null, w real not null, h real not null,
  confidence real,
  confirmed integer not null default 0 check (confirmed in (0,1)),
  embedding blob
);
create index face_photo on face(photo_id);
create index face_person on face(person_id);

-- Assisted culling results, cached per photo
create table cull_score (
  photo_id integer primary key references photo(id) on delete cascade,
  subject_focus real, eye_focus real, eyes_open real, face_count integer,
  model_version text not null
);

create table saved_location (
  id integer primary key,
  name text not null,
  parent_id integer references saved_location(id) on delete cascade,
  lat real not null, lon real not null, radius_m real not null default 100
);

create table tracklog (
  id integer primary key,
  name text not null,
  points_blob blob not null              -- packed lat, lon, time
);

create table publish_target (            -- local folder / SFTP targets only
  id integer primary key,
  name text not null,
  kind text not null check (kind in ('folder','sftp')),
  settings_json text not null
);

create table job (                       -- background work queue, survives a crash
  id integer primary key,
  kind text not null check (kind in ('preview','smart_preview','exif_read','sidecar_write','sidecar_read','face','cull','export','file_scan')),
  photo_id integer references photo(id) on delete cascade,
  payload_json text,
  priority integer not null default 5,
  state text not null default 'queued' check (state in ('queued','running','done','failed','cancelled')),
  attempts integer not null default 0,
  error text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index job_pick on job(state, priority, id);
create index job_photo on job(photo_id);

-- Full-text search for the Text filter
create virtual table photo_search using fts5(
  title, caption, keywords, filename, camera, content = '', tokenize = 'unicode61 remove_diacritics 2'
);

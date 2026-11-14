# Lucent Raw

A RAW photo organiser and editor for Windows that works offline: no account, no cloud, no subscription. Your photos and your catalog stay on your own computer, and your original files are never changed.

**Status: in testing.** Tester builds are on the [Releases page](https://github.com/Bennett-ttenneb/lucent-raw/releases). The installer is not code-signed yet, so Windows will show a warning.

## What it does

- **Library**: import, stars, flags, colour labels, keywords, collections
- **Develop**: non-destructive editing of RAW and other photos, with masks and spot removal
- **Retouch**, **Book** and **Export**
- Built-in models for subject, sky, depth and face-aware tools, all running on your computer

The full list is in the [user guide](docs/user-guide.md), including what is not built yet.

## How it is made

Tauri 2, a Rust core (`app/src-tauri/src`), React and TypeScript for the window, and a SQLite catalog. See the [developer guide](docs/developer-guide.md) and [testing notes](docs/TESTING.md).

## Building

```bash
cd app
npm ci
npx tauri build --bundles nsis
```

Some model files are not in this repository, and the program will not compile without them. See [MODELS-NOT-INCLUDED.md](MODELS-NOT-INCLUDED.md).

## Documents

- [User guide](docs/user-guide.md)
- [Privacy policy](docs/privacy-policy.md) and [terms](docs/terms-and-conditions.md)
- [Security policy](SECURITY.md)
- [Third-party material](THIRD_PARTY.md) and [licences](licences/)

## Licence

Copyright © 2026 BBotnics Industries. All rights reserved. The source is published to be read; no licence to reuse it is granted. Third-party parts keep their own licences.

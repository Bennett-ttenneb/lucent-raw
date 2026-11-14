#!/bin/bash
source ~/.cargo/env 2>/dev/null
rsync -a --delete --exclude target --exclude node_modules '/mnt/c/Lucent Raw/replica/app/' ~/lucent/
cd ~/lucent/src-tauri
export XWIN_ACCEPT_LICENSE=1
cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis --config '{"build":{"beforeBuildCommand":""}}' > ~/build.log 2>&1
echo exit=$? >> ~/build.log
tail -6 ~/build.log
ls -la target/x86_64-pc-windows-msvc/release/bundle/nsis
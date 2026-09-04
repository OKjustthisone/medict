# Medict Tauri 2 migration workspace

This directory is an independent migration workspace. The existing Electron
source tree and the root `package.json` are intentionally not changed by this
migration step.

## Current structure

```text
tauri-app/
├─ frontend/
│  ├─ index.html          # copied from ../src/renderer/index.html
│  ├─ renderer.js         # copied renderer UI logic
│  ├─ styles.css          # copied renderer styles
│  ├─ medict-icon.svg     # copied application asset
│  └─ tauri-bridge.js     # Electron preload-compatible Tauri adapter
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ build.rs
│  ├─ tauri.conf.json
│  ├─ capabilities/default.json
│  ├─ icons/medict.ico
│  └─ src/main.rs
├─ package.json
└─ README.md
```

The repository-level `crates/medict-core/` directory contains the shared Rust
dictionary and drug query core used by this workspace and the Native Win32 client.

## Run after installing prerequisites

From this directory:

```powershell
npm install
npm run check:frontend
npm run dev
```

The Tauri CLI and Rust toolchain are not vendored in this directory. Windows
development also needs the MSVC C++ linker (link.exe) and WebView2. The
current machine has Rustup/Rust installed, but still needs Visual Studio Build
Tools with the C++ workload before cargo check or tauri build can finish.

## Build without Visual Studio Build Tools

When `link.exe` is unavailable, the project also provides a no-admin GNU
fallback. It uses the portable MinGW-w64 directory at
`%USERPROFILE%\.w64devkit` by default, or the directory specified by
`MEDICT_MINGW_ROOT`:

```powershell
npm run build:gnu
```

This selects the `stable-x86_64-pc-windows-gnu` Rust toolchain, ensures the
Windows selection helper exists, and produces an unpacked executable without
creating an installer:

```text
src-tauri/target/x86_64-pc-windows-gnu/release/medict-tauri.exe
```

To create the Tauri bundle with the same GNU toolchain, run
`npm run build:gnu:bundle`. The regular `npm run build` command remains the
standard Tauri/MSVC build path.

To force a rebuild of the selection helper, run
`npm run build:gnu -- rebuild-helper`.

If the current executable is still running and Windows locks the default
output, set `MEDICT_CARGO_TARGET_DIR` to another directory under
`src-tauri\target` before building.

## Migration boundary

The copied renderer can now be developed without Electron imports. The Rust
side provides the command names required by the renderer for window controls,
settings persistence, language-pair persistence, and dictionary lookups. The
current migrated providers are the Youdao web dictionary/translation service,
Free Dictionary, RxNorm, RxClass and PubChem. They run from the Rust side so
the renderer does not receive network or credential privileges. The remaining
providers are being ported one at a time behind the same result contract.

The dictionary and drug provider implementations now live in the repository-level
`crates/medict-core` crate and are shared with the Native Win32 client.

Not yet ported:

- Baidu, Google and other dictionary/translation HTTP providers;
- DrugShop's ChEMBL, FDA and ClinicalTrials.gov enrichment pipeline;
- Windows selection helper and automatic selection monitor;
- global shortcuts and shortcut recording;
- Electron-specific partial-result streaming.

The remaining placeholder responses identify these boundaries instead of
pretending that the Electron service implementations already run in Tauri.

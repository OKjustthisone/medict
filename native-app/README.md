# Medict Native Windows

这是 Medict 的原生 Windows 实验版本，采用：

- Rust 负责应用状态、网络请求、快捷键和后台线程；
- Win32 负责窗口、输入框、按钮、托盘和消息循环；
- Direct2D + DirectWrite 负责结果区域绘制；
- 不加载 Electron、Chromium 或 WebView2；
- 不启动 `SelectionHelper.exe`，选词快捷键使用原生剪贴板回读路径。

当前版本用于验证原生 UI 和内存基线。词典、药物查询模块复用
`tauri-app/src-tauri/src/word_lookup.rs` 与 `drug_lookup.rs`，后续可以再移动到
仓库级共享 Rust crate，避免两个版本继续通过路径引用。

## 开发运行

在项目根目录执行：

```powershell
cargo run --manifest-path native-app/Cargo.toml
```

## Release 构建

```powershell
cargo build --release --manifest-path native-app/Cargo.toml
```

当前 GNU 工具链需要把已有的 w64devkit 放入当前 PowerShell 的 PATH（不需要管理员权限）：

```powershell
$env:Path = "C:\Users\xin.zhou\.w64devkit\bin;$env:Path"
cargo build --release --manifest-path native-app/Cargo.toml
```

`windres` 会把仓库现有的 `build/medict.ico` 嵌入原生 exe；如果本机使用其他
MinGW 安装，只要其 `windres.exe` 位于 PATH 中即可。

产物位于：

```text
native-app/target/release/medict-native.exe
```

快捷键：

- `Alt+M`：显示面板并聚焦输入框；
- `Alt+D`：读取当前选中文本并查询；
- `Esc`：隐藏面板，程序继续在系统托盘后台运行。

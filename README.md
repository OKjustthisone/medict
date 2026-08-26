# Medict

Medict 是一个面向 Windows 的小型桌面查词窗口。界面参考 [pot-desktop](https://github.com/pot-app/pot-desktop) 的轻量弹窗思路，但查询模型只有一个输入框和两个动作：

- **查词**：单词调用网易有道网页词典和其他在线词典，返回英美分开的音标与发音、词性、多义项、词形、词组和双语例句；短语或句子自动切换为网易有道网页翻译，也可叠加 Google / 百度翻译。
- **药物查询**：调用从 `drugshop` 集成的完整公开数据查询链路。
- **自动划词**：在其他 Windows 应用中用鼠标选中文本后，自动执行普通查词并弹出结果窗口；DrugShop 只在点击“药物查询”按钮时请求。自动查词可以在设置中开关。
- **快捷键**：默认使用 `Ctrl + Alt + M` 打开面板，使用 `Alt + D` 读取当前选区并查询；两个快捷键都可在设置中重新录入或清除。
- **缓存与阅读**：药物结果跨重启缓存 7 天；设置里可调整结果字号。翻译行的复制按钮只复制译文本身，不包含语言方向和服务来源。
- **语言与历史**：主面板可选择“自动识别 → 简体中文”等语言方向并一键互换，也支持“简体中文 → English”的汉英查询；历史按钮保留最近 10 次查词或药物查询。
- **快速首屏**：有道使用精简字段快速通道，V4 接口作为自动后备；有道词典先返回时立即显示，Free Dictionary、Google 和百度继续在后台补充。相同语言方向的成功查词会在本次运行中缓存 12 小时。

## 当前可运行范围

当前版本不加载或分发本地词典，启动时只初始化在线服务、药物缓存和划词助手。网易有道网页服务可在设置中开关：单词走网页词典，短语和长文本走网页翻译，不需要 API Key；Free Dictionary 也可以单独开关。默认服务顺序为网易有道、Free Dictionary、百度、Google，用户可以在设置中用上下按钮调整。Google 兼容模式默认开启，也可以切换到 Google Cloud Translation API。短语和长文本不一定返回词典字段，会继续显示可用的翻译结果。

百度词典版使用官方 `texttrans-with-dict/v1` 接口：应用只保存用户输入的 API Key / Secret Key，并在本机换取短期 Access Token；百度服务权限、额度和词典字段以账号开通情况为准。标准版 QPS 较低时，Medict 会对百度请求按密钥排队，并在 QPS 错误后自动重试一次。百度接口没有返回完整词典数据时，Medict 会继续使用其他已启用的服务，不会因为百度失败而覆盖其他结果。

药物查询并行聚合以下公开服务：

- RxNorm / RxNav / RxClass
- ChEMBL
- UniProt
- PubChem
- Drugs@FDA
- ClinicalTrials.gov

结果包含名称和别名、结构、处方信息、分类、靶点与机制、适应症、FDA 批准、临床试验、标准化药理活性和原始来源链接。它只用于信息检索，不构成诊断或治疗建议。

## 运行

```powershell
npm.cmd install
npm.cmd test
npm.cmd start
```

生成 Windows 安装包：

```powershell
npm.cmd run dist
```

`npm start` 和打包前会自动使用 Windows 自带的 .NET Framework C# 编译器生成 `SelectionHelper.exe`。该助手负责跨应用鼠标划词和快捷键选区读取，不需要额外安装 .NET SDK。

默认快捷键 `Ctrl + Alt + M` 只负责打开面板；`Alt + D` 会读取当前应用的选中文本并立即查询。两者都可在设置中修改。关闭按钮默认隐藏到系统托盘；可以在设置中彻底退出。

## 查词顺序

```text
输入或划词
   │
   ├─ 单词/汉英词典 ─→ 按设置顺序显示已启用的在线服务
   │                 ├─ 网易有道网页词典：快速显示简明释义、双发音、词形、词组与例句
   │                 ├─ 百度词典版：中英词典字段
   │                 ├─ Free Dictionary：英文完整义项
   │                 └─ Google：整词翻译补充
   └─ 短语或文本 ─→ 网易有道网页翻译 + 其他已启用翻译服务

划词事件只启动上面的普通查词流程

点击“药物查询” ─→ 单独启动 DrugShop 药物数据流程
```

## 自动划词说明

Windows 助手优先通过 UI Automation 读取选中文字；不支持的应用会临时发送 `Ctrl+C`，读取后尽量恢复原剪贴板内容。密码输入框会被跳过，文本只在本机进入查词流程，不会写入日志。

当前自动触发针对鼠标选词。某些以管理员身份运行、受保护或不暴露可访问性信息的应用，可能需要以相同权限运行 Medict 才能读取选区。

当前在线英英释义来自 Free Dictionary API；百度词典版提供中英词典字段。应用显示接口响应中附带的原始词条链接和许可证信息，不复制或打包其词典数据库；若某个公共服务不可用，其他已配置的服务仍可独立返回。

## 云端服务说明

默认的“免密钥兼容模式”用于快速试用，调用 Google 翻译的兼容接口，接口可能随服务调整而变化。需要稳定生产使用时，建议在设置中切换到正式 Google Cloud Translation API。API Key 和有道密钥保存在 Electron 用户数据目录，不会提交到 Git；后续版本应再接入 Windows Credential Manager / Electron `safeStorage`。

百度词典版需要在百度智能云控制台开通对应服务，并在 Medict 设置中填写 API Key 和 Secret Key。百度返回的词典资源包括英文释义、中文释义、音标、核心词汇类别、例句和词形变化等，但单个查询为句子或账号没有词典版权限时，接口可能只返回普通翻译。

## 项目结构

```text
crates/medict-core/          Rust 共享词典 / 药物查询核心
src/renderer/                 紧凑单窗口 UI
src/main/main.js              窗口、托盘、并行查询和 IPC
src/main/services/word-lookup.js 在线词典 / 云端回退编排
src/main/services/dictionary-api.js Free Dictionary / Oxford / Merriam-Webster 适配
src/main/services/translation.js Google / 有道 / 百度词典版适配与限流
src/main/services/drugshop.js DrugShop 公开数据库聚合
src/main/selection-monitor.js Windows 划词助手进程管理
src/native/SelectionHelper.cs Windows 全局鼠标与选区读取
src/assets/medict-icon.svg        主面板原子轨道图标
tools/build-icon.js               生成 Windows ICO 与托盘图标
```

Medict 没有复制 pot-desktop 的源代码；它只参考了紧凑弹窗、多服务查询和划词工作流。pot-desktop 本身采用 GPL-3.0 许可证，继续借用其代码前应单独评估许可证兼容性。

# Medict

Medict 是一个面向 Windows 的小型桌面查词窗口。界面参考 [pot-desktop](https://github.com/pot-app/pot-desktop) 的轻量弹窗思路，但查询模型只有一个输入框和两个动作：

- **查词**：先查本地词典的精确词条；没有命中时，可用百度官方“文本翻译-词典版”返回音标、词性、中英多义项、例句和词形变化；未启用或未命中时回退到 Free Dictionary，再由 Google / 有道补充整词翻译。词典详细义项优先显示，云端整词翻译排在后面。
- **药物查询**：调用从 `drugshop` 集成的完整公开数据查询链路。
- **自动划词**：在其他 Windows 应用中用鼠标选中文本后，同时执行上面两条查询，并弹出同一个结果窗口；不是药物时明确显示“未找到该药物”。该行为可以在设置中开关。
- **快捷键**：默认使用 `Ctrl + Alt + M` 打开面板，使用 `Ctrl + Alt + D` 读取当前选区并查询；两个快捷键都可在设置中重新录入或清除。
- **缓存与阅读**：药物结果跨重启缓存 7 天；设置里可调整结果字号。翻译行的复制按钮只复制译文本身，不包含语言方向和服务来源。

## 当前可运行范围

本轮按需求暂不安装本地词典。英文单词会自动调用免密钥的 [Free Dictionary API](https://dictionaryapi.dev/)；如果在设置中填写百度智能云 API Key / Secret Key 并开通“文本翻译-词典版”，会优先使用百度的完整中英词典数据。应用默认启用 Google 免密钥兼容模式，也可以切换到 Google Cloud Translation API，或填写有道智云 App ID / App Secret 作为补充翻译。短语和长文本不一定返回词典字段，会继续显示可用的翻译结果。

百度词典版使用官方 `texttrans-with-dict/v1` 接口：应用只保存用户输入的 API Key / Secret Key，并在本机换取短期 Access Token；百度服务权限、额度和词典字段以账号开通情况为准。百度接口没有返回完整词典数据时，Medict 会继续使用 Free Dictionary / Google / 有道，不会因为百度失败而覆盖其他结果。

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

`npm start` 和打包前会自动使用 Windows 自带的 .NET Framework C# 编译器生成 `SelectionHelper.exe`。该助手负责跨应用鼠标划词监听，不需要额外安装 .NET SDK。

默认快捷键 `Ctrl + Alt + M` 只负责打开面板；`Ctrl + Alt + D` 会读取当前应用的选中文本并立即查询。两者都可在设置中修改。关闭按钮默认隐藏到系统托盘；可以在设置中彻底退出。

## 查词顺序

```text
输入或划词
   │
   ├─ 本地词典精确命中 ─→ 直接显示本地释义，不访问云端
   │
   └─ 本地未命中
        ├─ 单个英文词 ─→ 百度词典版（已配置且有返回时）
        │                 └─ 否则 Free Dictionary 完整义项
        │                     └─ Google / 有道补充整词翻译
        └─ 短语或文本 ─→ 百度 / Google / 有道直接翻译

划词事件同时启动：
   ├─ 上面的普通查词流程
   └─ DrugShop 药物数据流程
```

## 自动划词说明

Windows 助手优先通过 UI Automation 读取选中文字；不支持的应用会临时发送 `Ctrl+C`，读取后尽量恢复原剪贴板内容。密码输入框会被跳过，文本只在本机进入查词流程，不会写入日志。

当前自动触发针对鼠标选词。某些以管理员身份运行、受保护或不暴露可访问性信息的应用，可能需要以相同权限运行 Medict 才能读取选区。

## 本地词典规划与授权边界

GoldenDict 不是单一词典文件格式，它常用 StarDict、DSL、Dictd、MDict 等格式。下一阶段优先实现：

1. StarDict `.ifo/.idx/.dict`（以及 `.dict.dz`）只读解析；
2. DSL 只读解析；
3. MDict `.mdx/.mdd` 适配；
4. SQLite 索引，支持大型词库快速查询。

Oxford Advanced Learner's、Longman 和 Merriam-Webster 的完整词典内容并不因为可下载就自动成为开源内容。Medict 只提供格式适配和查询接口，不随程序分发这些词典；用户需要确认自己导入内容的许可证和使用权限。

当前在线英英释义来自 Free Dictionary API；百度词典版提供中英词典字段。应用显示接口响应中附带的原始词条链接和许可证信息，不复制或打包其词典数据库；若某个公共服务不可用，其他已配置的服务仍可独立返回。

## 云端服务说明

默认的“免密钥兼容模式”用于快速试用，调用 Google 翻译的兼容接口，接口可能随服务调整而变化。需要稳定生产使用时，建议在设置中切换到正式 Google Cloud Translation API。API Key 和有道密钥保存在 Electron 用户数据目录，不会提交到 Git；后续版本应再接入 Windows Credential Manager / Electron `safeStorage`。

百度词典版需要在百度智能云控制台开通对应服务，并在 Medict 设置中填写 API Key 和 Secret Key。百度返回的词典资源包括英文释义、中文释义、音标、核心词汇类别、例句和词形变化等，但单个查询为句子或账号没有词典版权限时，接口可能只返回普通翻译。

## 项目结构

```text
src/renderer/                 紧凑单窗口 UI
src/main/main.js              窗口、托盘、并行查询和 IPC
src/main/dictionary-manager.js 本地词典索引边界
src/main/services/word-lookup.js 本地优先 / 云端回退编排
src/main/services/dictionary-api.js Free Dictionary / Oxford / Merriam-Webster 适配
src/main/services/translation.js Google / 有道 / 百度词典版适配
src/main/services/drugshop.js DrugShop 公开数据库聚合
src/main/selection-monitor.js Windows 划词助手进程管理
src/native/SelectionHelper.cs Windows 全局鼠标与选区读取
```

Medict 没有复制 pot-desktop 的源代码；它只参考了紧凑弹窗、多服务查询和划词工作流。pot-desktop 本身采用 GPL-3.0 许可证，继续借用其代码前应单独评估许可证兼容性。

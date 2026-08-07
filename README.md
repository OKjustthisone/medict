# Medict

Medict 是一个面向 Windows 的桌面词典工作台，目标是把三类工作放到一个本地窗口里：

- 本地词典检索：先支持项目自带的示例词典，以及 JSON、ECDICT 风格 CSV、制表符 TXT 导入。
- 英英 / 英汉查询：通过授权的 Oxford Dictionaries API、Merriam-Webster Collegiate API 获取在线内容；Longman 等服务先提供官方网页跳转。
- 在线翻译与药物检索：支持 Google Cloud Translation、有道智云，以及从现有 `drugshop` 浏览器扩展移植的公开药物数据库查询层。

## 当前技术方案

第一版使用 Electron + 原生 HTML/CSS/JavaScript。服务适配器位于主进程，渲染层没有网络或文件系统权限：

```text
renderer/index.html + renderer.js
            │  preload bridge
            ▼
main/main.js ── settings / file import / IPC
      ├── dictionary-manager.js ── local JSON/CSV/TXT
      ├── services/dictionary-api.js ── Oxford / Merriam-Webster
      ├── services/translation.js ── Google / Youdao
      └── services/drugshop.js ── RxNorm / ChEMBL / PubChem / FDA / trials
```

这个分层借鉴了 pot-desktop 的“多服务并行 + 可扩展服务接口”思路，但没有复制 pot 的源代码。后续如果需要托盘常驻、划词快捷键、OCR 或更轻量的发布包，可以在接口不变的情况下增加 Windows 原生能力或迁移到 Tauri。

## 运行

在 Windows PowerShell 中执行：

```powershell
npm.cmd install
npm.cmd test
npm.cmd start
```

生成 Windows 安装包：

```powershell
npm.cmd run dist
```

当前没有把 API Key 写进项目。第一次启动后打开“服务与设置”，填写自己的凭据并启用对应服务。配置文件和导入词典会保存到 Electron 的用户数据目录，不会写入 Git 工作区。

## 本地词典格式

最简单的 JSON 格式如下：

```json
{
  "name": "My licensed dictionary",
  "license": "按原词典授权协议填写",
  "sourceUrl": "https://example.com",
  "entries": [
    {
      "word": "word",
      "phonetic": "/wɜːd/",
      "senses": [
        {
          "partOfSpeech": "noun",
          "definition": "A unit of language.",
          "translations": ["单词；词语"],
          "examples": ["This is an example sentence."]
        }
      ]
    }
  ]
}
```

也可以导入带 `word`、`phonetic`、`definition`、`translation`、`pos` 列的 CSV。应用会复制导入文件到用户数据目录，并在查询时对所有本地词典源并行检索。

## 数据源与授权边界

Oxford Advanced Learner's、Longman、Merriam-Webster 的完整词典内容不能因为“用于学习”就自动成为开源内容。Medict 只提供适配器、授权凭据输入和用户自行导入的本地文件；是否可以保存、缓存或再分发内容，要以各数据源的许可证、API 计划和服务条款为准。

药物查询仅用于信息检索和研究整理。当前结果会显示来源链接和部分数据源警告，不把公开数据库结果包装成医学诊断、处方或治疗建议。

## 下一阶段

1. 增加 StarDict `.ifo/.idx/.dict` 和 DSL 的只读解析器。
2. 把用户词典索引落到 SQLite，提升大词库的模糊搜索速度。
3. 增加托盘、全局快捷键、剪贴板查询和历史/生词本。
4. 将 DrugShop 的 AI 靶点摘要、文献检索和 Excel 导出作为独立的可选模块接入。
5. 为 API 密钥增加 Windows Credential Manager / Electron `safeStorage` 存储，并完善安装包签名。

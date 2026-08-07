const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform !== "win32") {
  console.log("SelectionHelper is Windows-only; build skipped.");
  process.exit(0);
}

const root = path.resolve(__dirname, "..");
const windowsDirectory = process.env.WINDIR || "C:\\Windows";
const frameworkDirectory = path.join(windowsDirectory, "Microsoft.NET", "Framework64", "v4.0.30319");
const compiler = path.join(frameworkDirectory, "csc.exe");
const wpfDirectory = path.join(frameworkDirectory, "WPF");
const source = path.join(root, "src", "native", "SelectionHelper.cs");
const outputDirectory = path.join(root, "build");
const output = path.join(outputDirectory, "SelectionHelper.exe");

if (!fs.existsSync(compiler)) {
  throw new Error(`Windows C# compiler not found: ${compiler}`);
}

fs.mkdirSync(outputDirectory, { recursive: true });
const result = spawnSync(compiler, [
  "/nologo",
  "/target:winexe",
  "/platform:x64",
  `/out:${output}`,
  "/reference:System.dll",
  "/reference:System.Core.dll",
  "/reference:System.Windows.Forms.dll",
  `/reference:${path.join(wpfDirectory, "UIAutomationClient.dll")}`,
  `/reference:${path.join(wpfDirectory, "UIAutomationTypes.dll")}`,
  `/reference:${path.join(wpfDirectory, "WindowsBase.dll")}`,
  source
], { stdio: "inherit" });

if (result.status !== 0) process.exit(result.status || 1);
console.log(`Built ${path.relative(root, output)}`);

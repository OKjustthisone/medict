const MODIFIER_ORDER = ["CommandOrControl", "Alt", "Shift"];

function normalizeKey(value) {
  const token = String(value || "").trim();
  if (/^[a-z]$/i.test(token)) return token.toUpperCase();
  if (/^[0-9]$/.test(token)) return token;
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(token)) return token.toUpperCase();
  const aliases = {
    space: "Space",
    tab: "Tab",
    enter: "Enter",
    return: "Enter",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right"
  };
  return aliases[token.toLowerCase()] || "";
}

function normalizeAccelerator(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const modifiers = new Set();
  let key = "";
  for (const part of raw.split("+").map(item => item.trim()).filter(Boolean)) {
    const token = part.toLowerCase().replace(/\s+/g, "");
    if (["ctrl", "control", "cmdorctrl", "commandorcontrol"].includes(token)) {
      modifiers.add("CommandOrControl");
      continue;
    }
    if (["alt", "option"].includes(token)) {
      modifiers.add("Alt");
      continue;
    }
    if (token === "shift") {
      modifiers.add("Shift");
      continue;
    }
    const normalizedKey = normalizeKey(part);
    if (!normalizedKey || key) throw new Error(`无法识别快捷键：${raw}`);
    key = normalizedKey;
  }
  if (!key || (!modifiers.has("CommandOrControl") && !modifiers.has("Alt"))) {
    throw new Error("快捷键必须包含 Ctrl 或 Alt，并带一个字母、数字或功能键");
  }
  return [...MODIFIER_ORDER.filter(modifier => modifiers.has(modifier)), key].join("+");
}

function validateShortcutConfiguration(value = {}) {
  const shortcuts = {
    showWindow: normalizeAccelerator(value.showWindow),
    selectionLookup: normalizeAccelerator(value.selectionLookup)
  };
  if (shortcuts.showWindow && shortcuts.showWindow.toLowerCase() === shortcuts.selectionLookup.toLowerCase()) {
    throw new Error("打开面板和选词查词不能使用同一个快捷键");
  }
  return shortcuts;
}

function registerShortcutConfiguration(registry, value, handlers) {
  const shortcuts = validateShortcutConfiguration(value);
  registry.unregisterAll();
  try {
    const entries = [
      ["打开面板", shortcuts.showWindow, handlers.showWindow],
      ["选词后查词", shortcuts.selectionLookup, handlers.selectionLookup]
    ];
    for (const [label, accelerator, handler] of entries) {
      if (!accelerator) continue;
      if (!registry.register(accelerator, handler)) {
        throw new Error(`${label}快捷键 ${accelerator} 已被其他程序占用`);
      }
    }
    return shortcuts;
  } catch (error) {
    registry.unregisterAll();
    throw error;
  }
}

module.exports = {
  normalizeAccelerator,
  registerShortcutConfiguration,
  validateShortcutConfiguration
};

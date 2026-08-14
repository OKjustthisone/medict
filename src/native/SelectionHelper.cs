using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using System.Windows.Forms;

internal static class SelectionHelper
{
    private const int WhMouseLl = 14;
    private const int WhKeyboardLl = 13;
    private const int WmLButtonUp = 0x0202;
    private const int WmKeyDown = 0x0100;
    private const int WmKeyUp = 0x0101;
    private const int WmSysKeyDown = 0x0104;
    private const int WmSysKeyUp = 0x0105;
    private const uint InputKeyboard = 1;
    private const ushort VkControl = 0x11;
    private const ushort VkLControl = 0xA2;
    private const ushort VkRControl = 0xA3;
    private const ushort VkMenu = 0x12;
    private const ushort VkLMenu = 0xA4;
    private const ushort VkRMenu = 0xA5;
    private const ushort VkShift = 0x10;
    private const ushort VkLShift = 0xA0;
    private const ushort VkRShift = 0xA1;
    private const ushort VkLwin = 0x5B;
    private const ushort VkRwin = 0x5C;
    private const uint LlkhfAltDown = 0x20;
    private const ushort VkC = 0x43;
    private const uint KeyeventfKeyup = 0x0002;
    private const uint GaRoot = 2;

    private static readonly LowLevelMouseProc MouseProc = HookCallback;
    private static readonly LowLevelKeyboardProc KeyboardProc = KeyboardHookCallback;
    private static IntPtr _hook = IntPtr.Zero;
    private static IntPtr _keyboardHook = IntPtr.Zero;
    private static IntPtr _medictWindow = IntPtr.Zero;
    private static int _parentPid;
    private static System.Windows.Forms.Timer _captureTimer;
    private static System.Windows.Forms.Timer _shortcutTimer;
    private static System.Windows.Forms.Timer _parentTimer;
    private static bool _mouseSelectionEnabled = true;
    private static bool _shortcutPending;
    private static bool _shortcutKeySuppressed;
    private static int _shortcutVirtualKey;
    private static bool _shortcutCtrl;
    private static bool _shortcutAlt;
    private static bool _shortcutShift;
    private static bool _trackedControlDown;
    private static bool _trackedAltDown;
    private static bool _trackedShiftDown;
    private static bool _trackedWindowsDown;
    private static IntPtr _shortcutForeground = IntPtr.Zero;
    private static string _shortcutSelectionSnapshot = "";
    private static string _lastText = "";
    private static DateTime _lastTextAt = DateTime.MinValue;

    [STAThread]
    private static void Main(string[] args)
    {
        bool captureOnce = args.Length > 0 && String.Equals(args[0], "--capture-once", StringComparison.OrdinalIgnoreCase);
        if (!captureOnce && args.Length > 0) int.TryParse(args[0], out _parentPid);
        const int windowArgument = 1;
        if (args.Length > windowArgument)
        {
            long handle;
            if (long.TryParse(args[windowArgument], out handle)) _medictWindow = new IntPtr(handle);
        }
        if (!captureOnce)
        {
            _shortcutVirtualKey = ParseShortcut(args.Length > 2 ? args[2] : "", out _shortcutCtrl, out _shortcutAlt, out _shortcutShift);
            _mouseSelectionEnabled = args.Length <= 3 || String.Equals(args[3], "1", StringComparison.Ordinal);
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        if (captureOnce)
        {
            WaitForShortcutKeysReleased();
            if (!CaptureAndPublish()) Publish("EMPTY");
            return;
        }

        _captureTimer = new System.Windows.Forms.Timer();
        _captureTimer.Interval = 180;
        _captureTimer.Tick += delegate
        {
            _captureTimer.Stop();
            CaptureAndPublish();
        };

        _shortcutTimer = new System.Windows.Forms.Timer();
        // Run almost immediately after the low-level hook returns. This gives
        // the page a chance to finish the selection while keeping Alt+D from
        // moving focus to Chrome's address bar before we read/copy it.
        _shortcutTimer.Interval = 5;
        _shortcutTimer.Tick += delegate
        {
            _shortcutTimer.Stop();
            CapturePendingShortcut();
        };

        _parentTimer = new System.Windows.Forms.Timer();
        _parentTimer.Interval = 2000;
        _parentTimer.Tick += delegate
        {
            if (_parentPid <= 0) return;
            try
            {
                Process.GetProcessById(_parentPid);
            }
            catch
            {
                Application.Exit();
            }
        };
        _parentTimer.Start();

        if (_mouseSelectionEnabled)
        {
            _hook = SetWindowsHookEx(WhMouseLl, MouseProc, GetModuleHandle(null), 0);
        }
        if (_shortcutVirtualKey != 0)
        {
            _keyboardHook = SetWindowsHookEx(WhKeyboardLl, KeyboardProc, GetModuleHandle(null), 0);
        }
        if (_hook == IntPtr.Zero && _keyboardHook == IntPtr.Zero)
        {
            Publish("ERROR\t无法安装 Windows 划词监听器（错误码 " + Marshal.GetLastWin32Error() + "）");
            return;
        }

        if (_keyboardHook != IntPtr.Zero) Publish("KEYBOARD_READY");
        Publish("READY");
        Application.Run();
        if (_hook != IntPtr.Zero) UnhookWindowsHookEx(_hook);
        if (_keyboardHook != IntPtr.Zero) UnhookWindowsHookEx(_keyboardHook);
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (_mouseSelectionEnabled && nCode >= 0 && wParam.ToInt32() == WmLButtonUp)
        {
            _captureTimer.Stop();
            _captureTimer.Start();
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    private static IntPtr KeyboardHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && _shortcutVirtualKey != 0)
        {
            int message = wParam.ToInt32();
            bool keyDown = message == WmKeyDown || message == WmSysKeyDown;
            bool keyUp = message == WmKeyUp || message == WmSysKeyUp;
            if (keyDown || keyUp)
            {
                KeyboardHookData data = (KeyboardHookData)Marshal.PtrToStructure(lParam, typeof(KeyboardHookData));
                int virtualKey = (int)data.virtualKey;
                UpdateTrackedModifierState(virtualKey, keyDown);
                bool altFromMessage = (data.flags & LlkhfAltDown) != 0
                    || message == WmSysKeyDown
                    || message == WmSysKeyUp;
                if (keyDown && virtualKey == _shortcutVirtualKey && ShortcutModifiersMatch(altFromMessage))
                {
                    _shortcutPending = true;
                    _shortcutKeySuppressed = true;
                    _shortcutForeground = GetAncestor(GetForegroundWindow(), GaRoot);
                    _shortcutSelectionSnapshot = "";
                    _shortcutTimer.Stop();
                    _shortcutTimer.Start();
                    // Prevent browsers from consuming Alt+D as "focus address bar".
                    return (IntPtr)1;
                }
                if (keyUp && _shortcutKeySuppressed && virtualKey == _shortcutVirtualKey)
                {
                    _shortcutKeySuppressed = false;
                    return (IntPtr)1;
                }
            }
        }
        return CallNextHookEx(_keyboardHook, nCode, wParam, lParam);
    }

    private static void CapturePendingShortcut()
    {
        if (!_shortcutPending) return;

        IntPtr foreground = _shortcutForeground != IntPtr.Zero
            ? _shortcutForeground
            : GetAncestor(GetForegroundWindow(), GaRoot);
        if (foreground == IntPtr.Zero || (_medictWindow != IntPtr.Zero && foreground == _medictWindow))
        {
            ResetShortcutCapture();
            Publish("EMPTY");
            return;
        }

        // UI Automation can read Chrome's selection while the shortcut keys
        // are still down. Try this first so Alt+D never reaches the browser.
        string selected = String.IsNullOrWhiteSpace(_shortcutSelectionSnapshot)
            ? TryReadUiAutomationSelection(foreground)
            : _shortcutSelectionSnapshot;
        if (!String.IsNullOrWhiteSpace(selected))
        {
            ResetShortcutCapture();
            if (!PublishSelection(selected, "SHORTCUT_TEXT")) Publish("EMPTY");
            return;
        }

        if (AnyShortcutKeyDown())
        {
            _shortcutTimer.Start();
            return;
        }

        ResetShortcutCapture();
        if (!CaptureAndPublish(foreground)) Publish("EMPTY");
    }

    private static bool AnyShortcutKeyDown()
    {
        return (GetAsyncKeyState(VkControl) & 0x8000) != 0
            || (GetAsyncKeyState(VkMenu) & 0x8000) != 0
            || (GetAsyncKeyState(VkShift) & 0x8000) != 0
            || (GetAsyncKeyState(VkLwin) & 0x8000) != 0
            || (GetAsyncKeyState(VkRwin) & 0x8000) != 0;
    }

    private static void UpdateTrackedModifierState(int virtualKey, bool keyDown)
    {
        if (virtualKey == VkControl || virtualKey == VkLControl || virtualKey == VkRControl)
        {
            _trackedControlDown = keyDown;
        }
        else if (virtualKey == VkMenu || virtualKey == VkLMenu || virtualKey == VkRMenu)
        {
            _trackedAltDown = keyDown;
        }
        else if (virtualKey == VkShift || virtualKey == VkLShift || virtualKey == VkRShift)
        {
            _trackedShiftDown = keyDown;
        }
        else if (virtualKey == VkLwin || virtualKey == VkRwin)
        {
            _trackedWindowsDown = keyDown;
        }
    }

    private static bool ShortcutModifiersMatch(bool altFromMessage)
    {
        bool controlDown = _trackedControlDown || (GetAsyncKeyState(VkControl) & 0x8000) != 0;
        bool altDown = _trackedAltDown || altFromMessage || (GetAsyncKeyState(VkMenu) & 0x8000) != 0;
        bool shiftDown = _trackedShiftDown || (GetAsyncKeyState(VkShift) & 0x8000) != 0;
        bool windowsDown = _trackedWindowsDown
            || (GetAsyncKeyState(VkLwin) & 0x8000) != 0
            || (GetAsyncKeyState(VkRwin) & 0x8000) != 0;
        return controlDown == _shortcutCtrl
            && altDown == _shortcutAlt
            && shiftDown == _shortcutShift
            && !windowsDown;
    }

    private static void ResetShortcutCapture()
    {
        _shortcutPending = false;
        _shortcutKeySuppressed = false;
        _shortcutForeground = IntPtr.Zero;
        _shortcutSelectionSnapshot = "";
    }

    private static int ParseShortcut(string value, out bool control, out bool alt, out bool shift)
    {
        control = false;
        alt = false;
        shift = false;
        int key = 0;
        string[] parts = String.IsNullOrWhiteSpace(value) ? new string[0] : value.Split('+');
        foreach (string rawPart in parts)
        {
            string part = (rawPart ?? "").Trim();
            string token = part.ToLowerInvariant().Replace(" ", "");
            if (token == "ctrl" || token == "control" || token == "cmdorctrl" || token == "commandorcontrol")
            {
                control = true;
                continue;
            }
            if (token == "alt" || token == "option")
            {
                alt = true;
                continue;
            }
            if (token == "shift")
            {
                shift = true;
                continue;
            }
            int parsed = ParseVirtualKey(part);
            if (parsed == 0 || key != 0) return 0;
            key = parsed;
        }
        return key != 0 && (control || alt) ? key : 0;
    }

    private static int ParseVirtualKey(string value)
    {
        string token = (value ?? "").Trim();
        if (token.Length == 1)
        {
            char character = Char.ToUpperInvariant(token[0]);
            if ((character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9')) return character;
        }
        if (token.Length > 1 && (token[0] == 'F' || token[0] == 'f'))
        {
            int functionNumber;
            if (Int32.TryParse(token.Substring(1), out functionNumber) && functionNumber >= 1 && functionNumber <= 24)
            {
                return 0x70 + functionNumber - 1;
            }
        }
        switch (token.ToLowerInvariant())
        {
            case "space": return 0x20;
            case "tab": return 0x09;
            case "enter":
            case "return": return 0x0D;
            case "home": return 0x24;
            case "end": return 0x23;
            case "pageup": return 0x21;
            case "pagedown": return 0x22;
            case "up": return 0x26;
            case "down": return 0x28;
            case "left": return 0x25;
            case "right": return 0x27;
            default: return 0;
        }
    }

    private static bool CaptureAndPublish()
    {
        return CaptureAndPublish(IntPtr.Zero);
    }

    private static bool CaptureAndPublish(IntPtr preferredForeground)
    {
        IntPtr foreground = preferredForeground != IntPtr.Zero
            ? GetAncestor(preferredForeground, GaRoot)
            : GetAncestor(GetForegroundWindow(), GaRoot);
        if (foreground == IntPtr.Zero || (_medictWindow != IntPtr.Zero && foreground == _medictWindow)) return false;

        string selected = "";
        for (int attempt = 0; attempt < 3; attempt++)
        {
            if (attempt == 1) Thread.Sleep(90);
            if (attempt == 2) Thread.Sleep(180);

            selected = TryReadUiAutomationSelection(foreground);
            if (String.IsNullOrWhiteSpace(selected)) selected = TryCopySelection();
            if (!String.IsNullOrWhiteSpace(selected)) break;
        }
        selected = NormalizeSelection(selected);
        if (String.IsNullOrWhiteSpace(selected)) return false;

        return PublishSelection(selected, "TEXT");
    }

    private static bool PublishSelection(string selected, string messageType)
    {
        selected = NormalizeSelection(selected);
        if (String.IsNullOrWhiteSpace(selected)) return false;
        DateTime now = DateTime.UtcNow;
        if (selected == _lastText && (now - _lastTextAt).TotalMilliseconds < 900) return true;
        _lastText = selected;
        _lastTextAt = now;
        string payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(selected));
        Publish(messageType + "\t" + payload);
        return true;
    }

    private static void WaitForShortcutKeysReleased()
    {
        for (int attempt = 0; attempt < 40; attempt++)
        {
            bool controlDown = (GetAsyncKeyState(VkControl) & 0x8000) != 0;
            bool altDown = (GetAsyncKeyState(VkMenu) & 0x8000) != 0;
            bool shiftDown = (GetAsyncKeyState(VkShift) & 0x8000) != 0;
            bool windowsDown = (GetAsyncKeyState(VkLwin) & 0x8000) != 0 || (GetAsyncKeyState(VkRwin) & 0x8000) != 0;
            if (!controlDown && !altDown && !shiftDown && !windowsDown)
            {
                Thread.Sleep(45);
                return;
            }
            Thread.Sleep(20);
        }
    }

    private static string TryReadUiAutomationSelection(IntPtr foreground)
    {
        string selected = "";
        try
        {
            selected = ReadUiAutomationSelection(AutomationElement.FocusedElement);
        }
        catch
        {
        }
        if (!String.IsNullOrWhiteSpace(selected)) return selected;

        try
        {
            AutomationElement root = AutomationElement.FromHandle(foreground);
            if (root == null) return "";
            AutomationElement focused = root.FindFirst(
                TreeScope.Descendants,
                new PropertyCondition(AutomationElement.HasKeyboardFocusProperty, true));
            selected = ReadUiAutomationSelection(focused);
            if (!String.IsNullOrWhiteSpace(selected)) return selected;

            // Chrome pages do not expose the selected DOM text consistently
            // through the focused element. Search the renderer's text-pattern
            // elements as a bounded fallback; this covers GitHub code blocks,
            // reader views, and extension-backed Markdown pages.
            AutomationElementCollection candidates = root.FindAll(
                TreeScope.Descendants,
                new PropertyCondition(AutomationElement.IsTextPatternAvailableProperty, true));
            int count = Math.Min(candidates.Count, 128);
            for (int index = 0; index < count; index++)
            {
                selected = ReadUiAutomationSelection(candidates[index]);
                if (!String.IsNullOrWhiteSpace(selected)) return selected;
            }
            return "";
        }
        catch
        {
            return "";
        }
    }

    private static string ReadUiAutomationSelection(AutomationElement focused)
    {
        if (focused == null) return "";
        try
        {
            object passwordValue = focused.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty, true);
            if (passwordValue is bool && (bool)passwordValue) return "";

            object pattern;
            if (!focused.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) return "";
            TextPatternRange[] ranges = ((TextPattern)pattern).GetSelection();
            if (ranges == null || ranges.Length == 0) return "";
            List<string> values = new List<string>();
            foreach (TextPatternRange range in ranges)
            {
                string value = range.GetText(-1);
                if (!String.IsNullOrWhiteSpace(value)) values.Add(value);
            }
            return String.Join("\n", values.ToArray());
        }
        catch
        {
            return "";
        }
    }

    private static string TryCopySelection()
    {
        DataObject snapshot = CloneClipboard();
        string probe = "__MEDICT_SELECTION_PROBE__" + Guid.NewGuid().ToString("N");
        bool probeWritten = false;
        try
        {
            Clipboard.SetText(probe, TextDataFormat.UnicodeText);
            probeWritten = true;
        }
        catch
        {
        }
        uint sequenceBefore = GetClipboardSequenceNumber();
        SendCopyShortcut();

        string selected = "";
        for (int attempt = 0; attempt < 16; attempt++)
        {
            Thread.Sleep(40);
            Application.DoEvents();
            try
            {
                if (Clipboard.ContainsText(TextDataFormat.UnicodeText))
                {
                    string candidate = Clipboard.GetText(TextDataFormat.UnicodeText);
                    bool clipboardChanged = GetClipboardSequenceNumber() != sequenceBefore;
                    bool textChanged = !String.Equals(candidate, probe, StringComparison.Ordinal);
                    bool copyProducedText = clipboardChanged || (probeWritten && textChanged);
                    if (!String.IsNullOrWhiteSpace(candidate) && copyProducedText && (!probeWritten || textChanged))
                    {
                        selected = candidate;
                        break;
                    }
                }
            }
            catch
            {
            }
        }

        if (snapshot != null)
        {
            try
            {
                Clipboard.SetDataObject(snapshot, true, 5, 30);
            }
            catch
            {
            }
        }
        else if (probeWritten)
        {
            try
            {
                Clipboard.Clear();
            }
            catch
            {
            }
        }
        return selected;
    }

    private static DataObject CloneClipboard()
    {
        try
        {
            System.Windows.Forms.IDataObject source = Clipboard.GetDataObject();
            if (source == null) return null;
            DataObject clone = new DataObject();
            foreach (string format in source.GetFormats(false))
            {
                try
                {
                    object value = source.GetData(format, false);
                    if (value != null) clone.SetData(format, value);
                }
                catch
                {
                }
            }
            return clone;
        }
        catch
        {
            return null;
        }
    }

    private static void SendCopyShortcut()
    {
        Input[] inputs = new Input[4];
        inputs[0] = KeyboardInput(VkControl, 0);
        inputs[1] = KeyboardInput(VkC, 0);
        inputs[2] = KeyboardInput(VkC, KeyeventfKeyup);
        inputs[3] = KeyboardInput(VkControl, KeyeventfKeyup);
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input)));
    }

    private static Input KeyboardInput(ushort key, uint flags)
    {
        Input input = new Input();
        input.type = InputKeyboard;
        input.union = new InputUnion();
        input.union.keyboard = new KeyboardInputData();
        input.union.keyboard.virtualKey = key;
        input.union.keyboard.flags = flags;
        return input;
    }

    private static string NormalizeSelection(string value)
    {
        if (String.IsNullOrWhiteSpace(value)) return "";
        string normalized = value.Replace("\0", "").Trim();
        if (normalized.Length > 4000) normalized = normalized.Substring(0, 4000);
        return normalized;
    }

    private static void Publish(string message)
    {
        try
        {
            Console.Out.WriteLine(message);
            Console.Out.Flush();
        }
        catch
        {
        }
    }

    private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint type;
        public InputUnion union;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public KeyboardInputData keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInputData
    {
        public ushort virtualKey;
        public ushort scanCode;
        public uint flags;
        public uint time;
        public IntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardHookData
    {
        public uint virtualKey;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr extraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc callback, IntPtr module, uint threadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc callback, IntPtr module, uint threadId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string moduleName);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);

    [DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);
}

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
    private const int WmLButtonUp = 0x0202;
    private const uint InputKeyboard = 1;
    private const ushort VkControl = 0x11;
    private const ushort VkC = 0x43;
    private const uint KeyeventfKeyup = 0x0002;
    private const uint GaRoot = 2;

    private static readonly LowLevelMouseProc MouseProc = HookCallback;
    private static IntPtr _hook = IntPtr.Zero;
    private static IntPtr _medictWindow = IntPtr.Zero;
    private static int _parentPid;
    private static System.Windows.Forms.Timer _captureTimer;
    private static System.Windows.Forms.Timer _parentTimer;
    private static string _lastText = "";
    private static DateTime _lastTextAt = DateTime.MinValue;

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length > 0) int.TryParse(args[0], out _parentPid);
        if (args.Length > 1)
        {
            long handle;
            if (long.TryParse(args[1], out handle)) _medictWindow = new IntPtr(handle);
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        _captureTimer = new System.Windows.Forms.Timer();
        _captureTimer.Interval = 180;
        _captureTimer.Tick += delegate
        {
            _captureTimer.Stop();
            CaptureAndPublish();
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

        _hook = SetWindowsHookEx(WhMouseLl, MouseProc, GetModuleHandle(null), 0);
        if (_hook == IntPtr.Zero)
        {
            Publish("ERROR\t无法安装 Windows 鼠标监听器");
            return;
        }

        Publish("READY");
        Application.Run();
        UnhookWindowsHookEx(_hook);
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && wParam.ToInt32() == WmLButtonUp)
        {
            _captureTimer.Stop();
            _captureTimer.Start();
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    private static void CaptureAndPublish()
    {
        IntPtr foreground = GetAncestor(GetForegroundWindow(), GaRoot);
        if (foreground == IntPtr.Zero || (_medictWindow != IntPtr.Zero && foreground == _medictWindow)) return;

        string selected = TryReadUiAutomationSelection();
        if (String.IsNullOrWhiteSpace(selected)) selected = TryCopySelection();
        selected = NormalizeSelection(selected);
        if (String.IsNullOrWhiteSpace(selected)) return;

        DateTime now = DateTime.UtcNow;
        if (selected == _lastText && (now - _lastTextAt).TotalMilliseconds < 900) return;
        _lastText = selected;
        _lastTextAt = now;
        string payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(selected));
        Publish("TEXT\t" + payload);
    }

    private static string TryReadUiAutomationSelection()
    {
        try
        {
            AutomationElement focused = AutomationElement.FocusedElement;
            if (focused == null) return "";
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
        uint sequenceBefore = GetClipboardSequenceNumber();
        DataObject snapshot = CloneClipboard();
        SendCopyShortcut();

        string selected = "";
        for (int attempt = 0; attempt < 6; attempt++)
        {
            Thread.Sleep(35);
            Application.DoEvents();
            if (GetClipboardSequenceNumber() == sequenceBefore) continue;
            try
            {
                if (Clipboard.ContainsText(TextDataFormat.UnicodeText))
                {
                    selected = Clipboard.GetText(TextDataFormat.UnicodeText);
                    break;
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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc callback, IntPtr module, uint threadId);

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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);
}

using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using System.Reflection;

[assembly: AssemblyTitle("RoseTV")]
[assembly: AssemblyProduct("RoseTV")]
[assembly: AssemblyDescription("RoseTV 桌面播放器")]

internal static class Launcher {
    [STAThread]
    private static void Main() {
        string root = Directory.GetParent(AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\')).FullName;
        string python = Path.Combine(root, "runtime", "pythonw.exe");
        if (!File.Exists(python)) {
            string configured = Environment.GetEnvironmentVariable("ROSETV_PYTHON");
            string local = Path.Combine(root, "tools", "python-path.txt");
            python = !String.IsNullOrEmpty(configured) ? configured : File.Exists(local) ? File.ReadAllText(local).Trim() : "pythonw.exe";
        }
        string script = Path.Combine(root, "tools", "rosetv_bridge.py");
        try {
            Process.Start(new ProcessStartInfo {
                FileName = python,
                Arguments = "\"" + script + "\"",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true
            });
        } catch (Exception error) {
            MessageBox.Show("RoseTV 启动失败：" + error.Message, "RoseTV");
        }
    }
}

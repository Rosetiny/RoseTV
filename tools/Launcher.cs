using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using System.Reflection;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Threading;

[assembly: AssemblyTitle("RoseTV")]
[assembly: AssemblyProduct("RoseTV")]
[assembly: AssemblyDescription("RoseTV 桌面播放器")]

internal static class Launcher {
    [STAThread]
    private static void Main(string[] args) {
        string folder = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string root = Directory.Exists(Path.Combine(folder, "tools")) ? folder : Directory.GetParent(folder).FullName;
        try {
            string python = Path.Combine(root, "runtime", "python", "pythonw.exe");
            string archive = Path.Combine(root, "runtime", "python-runtime.zip");
            using (Mutex extraction = new Mutex(false, "Local\\RoseTV.RuntimeExtraction")) {
                if (!extraction.WaitOne(0)) return;
                try {
                    if (!File.Exists(python) && File.Exists(archive)) {
                        string expected = File.ReadAllText(Path.Combine(root,"runtime","python-runtime.sha256")).Trim();
                        string actual;
                        using (SHA256 hash = SHA256.Create())
                        using (FileStream input = File.OpenRead(archive))
                            actual = BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
                        if (actual != expected) throw new IOException("运行环境文件校验失败，请重新下载完整项目。");
                        string temporary = Path.Combine(root,"runtime",".extract-"+Guid.NewGuid().ToString("N"));
                        ZipFile.ExtractToDirectory(archive,temporary);
                        Directory.Move(temporary,Path.GetDirectoryName(python));
                    }
                } finally { extraction.ReleaseMutex(); }
            }
            if (!File.Exists(python)) python=Path.Combine(root,"runtime","pythonw.exe");
            if (!File.Exists(python)) {
                string configured = Environment.GetEnvironmentVariable("ROSETV_PYTHON");
                string local = Path.Combine(root, "tools", "python-path.txt");
                python = !String.IsNullOrEmpty(configured) ? configured : File.Exists(local) ? File.ReadAllText(local).Trim() : "pythonw.exe";
            }
            string script = Path.Combine(root,"tools","start.py");
            string arguments="\""+script+"\"";
            foreach (string arg in args) arguments+=" \""+arg.Replace("\"","\\\"")+"\"";
            Process.Start(new ProcessStartInfo {
                FileName = python,
                Arguments = arguments,
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true
            });
        } catch (Exception error) {
            MessageBox.Show("RoseTV 启动失败：" + error.Message, "RoseTV");
        }
    }
}

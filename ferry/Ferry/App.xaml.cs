using System.IO;
using System.Text.Json;
using System.Windows;

namespace Islands.Ferry;

/// <summary>Where the ferry goes and who's on it: %APPDATA%\Islands\ferry.json, overridden by --home / --pipe / --as.</summary>
public sealed class FerrySettings
{
    public string Home { get; set; } = "";
    public string Pipe { get; set; } = "pandora-island";
    public string As { get; set; } = Environment.UserName;
    public static string File => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Islands", "ferry.json");

    public static FerrySettings Load(string[] args)
    {
        FerrySettings s;
        try { s = JsonSerializer.Deserialize<FerrySettings>(System.IO.File.ReadAllText(File), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new(); } catch { s = new(); }
        string? Arg(string n) { var i = Array.IndexOf(args, n); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
        s.Home = Arg("--home") ?? s.Home;
        s.Pipe = Arg("--pipe") ?? s.Pipe;
        s.As = Arg("--as") ?? s.As;
        return s;
    }

    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(File)!);
        System.IO.File.WriteAllText(File, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }
}

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var s = FerrySettings.Load(e.Args);
        string? Arg(string n) { var i = Array.IndexOf(e.Args, n); return i >= 0 && i + 1 < e.Args.Length ? e.Args[i + 1] : null; }
        if (string.IsNullOrWhiteSpace(s.Home) || !Directory.Exists(s.Home))
        {
            var pick = new Microsoft.Win32.OpenFolderDialog { Title = "Where is the island's home? (the folder with vault, chats, state …)" };
            if (pick.ShowDialog() != true) { Shutdown(); return; }
            s.Home = pick.FolderName;
            s.Save();
        }
        var w = new MainWindow(s, snapshot: Arg("--snapshot"), openChat: Arg("--chat")) { SendOnStart = Arg("--send") };
        MainWindow = w;
        w.Show();
    }
}

// The harbor: the island's Windows service host.
//
// - It runs as the island's own account (a virtual service account such as NT SERVICE\PandoraDee: no password, no
//   keyboard sign-in, not an administrator), so the island keeps going when no window is open, when the person logs
//   out, and across reboots.
// - It starts the core (Node, core/bin/island.ts) and starts it again if it falls, waiting a little longer each time.
// - It owns the island's front door, the named pipe ferries connect to. Node can't say who may open a pipe, so the
//   harbor makes the pipe with a security descriptor that lets in only the island's account and the people named in
//   harbor.json, and nobody from the network. It passes each connection through to the core's private door, where the
//   ferry still has to present the island's token in island.hello.
//
//   harbor.exe --config <harbor.json>             as a Windows service (what install.ps1 sets up)
//   harbor.exe --config <harbor.json> --console   in a console, as whoever runs it (Ctrl+C, or "stop" on stdin)

using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Islands.Harbor;

var configPath = Arg(args, "--config") ?? Path.Combine(AppContext.BaseDirectory, "harbor.json");
var console = args.Contains("--console");
HarborConfig config;
try { config = HarborConfig.Load(configPath); }
catch (Exception e) { Console.Error.WriteLine($"harbor: {e.Message}"); return 2; }

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(o => o.ServiceName = config.ServiceName);
builder.Services.AddSingleton(config);
builder.Services.AddHostedService<Harbor>();
builder.Logging.ClearProviders();
builder.Logging.AddProvider(new FileLogProvider(Path.Combine(config.Home, "state", "harbor.log")));
if (console) builder.Logging.AddSimpleConsole(o => o.SingleLine = true);
var host = builder.Build();
if (console)
{
    // "stop" on stdin stops it cleanly too (for tests and for scripts that can't send Ctrl+C)
    _ = Task.Run(async () =>
    {
        string? line;
        while ((line = await Console.In.ReadLineAsync()) != null)
            if (line.Trim() == "stop") { await host.StopAsync(); return; }
    });
}
await host.RunAsync();
return 0;

static string? Arg(string[] a, string name) { var i = Array.IndexOf(a, name); return i >= 0 && i + 1 < a.Length ? a[i + 1] : null; }

namespace Islands.Harbor
{
    public sealed class HarborConfig
    {
        public string ServiceName { get; set; } = "PandoraDee";
        /// <summary>The island's home folder (vault, chats, log, state …).</summary>
        public string Home { get; set; } = "";
        /// <summary>The island's name, for its own events.</summary>
        public string Name { get; set; } = "island";
        /// <summary>node.exe (64-bit, Node 24 or newer).</summary>
        public string Node { get; set; } = "node";
        /// <summary>core/bin/island.ts</summary>
        public string Core { get; set; } = "";
        /// <summary>The front door's name: \\.\pipe\&lt;Pipe&gt;</summary>
        public string Pipe { get; set; } = "pandora-island";
        /// <summary>Who may open the front door besides the island's own account: account names or SIDs.</summary>
        public List<string> People { get; set; } = new();

        public static HarborConfig Load(string path)
        {
            if (!File.Exists(path)) throw new FileNotFoundException($"no config at {path}");
            var c = JsonSerializer.Deserialize<HarborConfig>(File.ReadAllText(path), new JsonSerializerOptions { PropertyNameCaseInsensitive = true, ReadCommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true })
                ?? throw new InvalidDataException("harbor.json is empty");
            if (string.IsNullOrWhiteSpace(c.Home)) throw new InvalidDataException("harbor.json needs \"home\"");
            if (string.IsNullOrWhiteSpace(c.Core) || !File.Exists(c.Core)) throw new InvalidDataException($"harbor.json's \"core\" isn't a file: {c.Core}");
            if (!System.Text.RegularExpressions.Regex.IsMatch(c.Pipe, @"^[\w.-]{1,100}$")) throw new InvalidDataException("harbor.json's \"pipe\" is a plain name");
            c.Home = Path.GetFullPath(c.Home);
            Directory.CreateDirectory(Path.Combine(c.Home, "state"));
            return c;
        }

        /// <summary>The SIDs the front door admits: the account the harbor runs as, and each person.</summary>
        public List<SecurityIdentifier> Admitted()
        {
            var list = new List<SecurityIdentifier> { WindowsIdentity.GetCurrent().User! };
            foreach (var p in People)
            {
                SecurityIdentifier sid;
                try { sid = p.StartsWith("S-1-", StringComparison.OrdinalIgnoreCase) ? new SecurityIdentifier(p) : (SecurityIdentifier)new NTAccount(p).Translate(typeof(SecurityIdentifier)); }
                catch (Exception e) { throw new InvalidDataException($"harbor.json names \"{p}\", and Windows doesn't know that account ({e.Message})"); }
                if (!list.Contains(sid)) list.Add(sid);
            }
            return list;
        }
    }

    public sealed class Harbor : BackgroundService
    {
        private readonly HarborConfig config;
        private readonly ILogger<Harbor> log;
        private readonly Core core;

        public Harbor(HarborConfig config, ILogger<Harbor> log, ILoggerFactory lf)
        {
            this.config = config;
            this.log = log;
            core = new Core(config, lf.CreateLogger<Core>());
        }

        /// <summary>The front door's security: the admitted accounts may read and write; the network may not come in at all.</summary>
        public static PipeSecurity DoorSecurity(IEnumerable<SecurityIdentifier> admitted)
        {
            var ps = new PipeSecurity();
            ps.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            var me = WindowsIdentity.GetCurrent().User!;
            ps.SetOwner(me);
            ps.AddAccessRule(new PipeAccessRule(me, PipeAccessRights.FullControl, AccessControlType.Allow));
            foreach (var sid in admitted)
                if (sid != me) ps.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
            ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
            return ps;
        }

        protected override async Task ExecuteAsync(CancellationToken stop)
        {
            var security = DoorSecurity(config.Admitted());
            await File.WriteAllTextAsync(Path.Combine(config.Home, "state", "harbor.json"), JsonSerializer.Serialize(new
            {
                pipe = $@"\\.\pipe\{config.Pipe}",
                pid = Environment.ProcessId,
                account = WindowsIdentity.GetCurrent().Name,
                door = security.GetSecurityDescriptorSddlForm(AccessControlSections.Access),
                startedAt = DateTime.UtcNow.ToString("o"),
            }, new JsonSerializerOptions { WriteIndented = true }), stop);
            log.LogInformation("harbor up as {Account}; door \\\\.\\pipe\\{Pipe}", WindowsIdentity.GetCurrent().Name, config.Pipe);

            var running = core.RunAsync(stop);
            var first = true;
            while (!stop.IsCancellationRequested)
            {
                NamedPipeServerStream door;
                try
                {
                    // the first instance claims the name, so nothing else can be listening under it already
                    door = NamedPipeServerStreamAcl.Create(config.Pipe, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances, PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous | (first ? PipeOptions.FirstPipeInstance : PipeOptions.None), 0, 0, security);
                }
                catch (Exception e) when (first)
                {
                    log.LogCritical("couldn't open the door {Pipe}: {Message}. Is another harbor running, or something else using that name?", config.Pipe, e.Message);
                    throw;
                }
                first = false;
                try { await door.WaitForConnectionAsync(stop); }
                catch (OperationCanceledException) { await door.DisposeAsync(); break; }
                _ = Task.Run(() => Ferry(door, stop), CancellationToken.None);
            }
            await running;
        }

        /// <summary>Pass one ferry's connection through to the core's private door, both ways, until either side ends.</summary>
        private async Task Ferry(NamedPipeServerStream door, CancellationToken stop)
        {
            await using var _ = door;
            string who = "someone";
            try { door.RunAsClient(() => who = WindowsIdentity.GetCurrent().Name); } catch { }
            var endpoint = core.Endpoint();
            if (endpoint is null) { log.LogWarning("a ferry ({Who}) came, but the core isn't up yet", who); return; }
            await using var inner = new NamedPipeClientStream(".", endpoint, PipeDirection.InOut, PipeOptions.Asynchronous);
            try { await inner.ConnectAsync(5000, stop); }
            catch (Exception e) { log.LogWarning("couldn't reach the core for {Who}: {Message}", who, e.Message); return; }
            log.LogInformation("ferry in: {Who}", who);
            using var both = CancellationTokenSource.CreateLinkedTokenSource(stop);
            var a = door.CopyToAsync(inner, both.Token);
            var b = inner.CopyToAsync(door, both.Token);
            try { await Task.WhenAny(a, b); } catch { }
            both.Cancel();
            log.LogInformation("ferry out: {Who}", who);
        }
    }

    /// <summary>The core: node core/bin/island.ts, kept running.</summary>
    public sealed class Core
    {
        private readonly HarborConfig config;
        private readonly ILogger log;
        private System.Diagnostics.Process? proc;

        public Core(HarborConfig config, ILogger log) { this.config = config; this.log = log; }

        /// <summary>The core's private pipe name (from state/core.json), or null if it isn't up.</summary>
        public string? Endpoint()
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(config.Home, "state", "core.json")));
                var ep = doc.RootElement.GetProperty("endpoint").GetString() ?? "";
                const string prefix = @"\\.\pipe\";
                return ep.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? ep[prefix.Length..] : null;
            }
            catch { return null; }
        }

        public async Task RunAsync(CancellationToken stop)
        {
            var wait = TimeSpan.FromSeconds(1);
            while (!stop.IsCancellationRequested)
            {
                var started = DateTime.UtcNow;
                var psi = new System.Diagnostics.ProcessStartInfo(config.Node)
                {
                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
                    WorkingDirectory = config.Home,
                };
                foreach (var a in new[] { config.Core, config.Home, "--name", config.Name }) psi.ArgumentList.Add(a);
                psi.Environment["ISLAND_STOP_ON_STDIN_END"] = "1";
                var logFile = Path.Combine(config.Home, "state", "core.log");
                try { proc = System.Diagnostics.Process.Start(psi)!; }
                catch (Exception e) { log.LogError("couldn't start the core ({Node}): {Message}", config.Node, e.Message); proc = null; }
                if (proc is not null)
                {
                    log.LogInformation("core started, pid {Pid}", proc.Id);
                    var p = proc;
                    var outs = Task.WhenAll(Pipe(p.StandardOutput, logFile), Pipe(p.StandardError, logFile));
                    try { await p.WaitForExitAsync(stop); }
                    catch (OperationCanceledException)
                    {
                        // ask it to stop (it logs island.stop and closes its door), then insist
                        try { p.StandardInput.Close(); } catch { }
                        using var grace = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                        try { await p.WaitForExitAsync(grace.Token); }
                        catch (OperationCanceledException) { try { p.Kill(entireProcessTree: true); } catch { } }
                        log.LogInformation("core stopped");
                        return;
                    }
                    try { await outs; } catch { }
                    log.LogWarning("core ended (exit code {Code})", p.ExitCode);
                }
                // fell over: start it again, waiting longer each time it falls quickly
                wait = DateTime.UtcNow - started > TimeSpan.FromMinutes(2) ? TimeSpan.FromSeconds(1) : TimeSpan.FromSeconds(Math.Min(60, wait.TotalSeconds * 2));
                try { await Task.Delay(wait, stop); } catch (OperationCanceledException) { return; }
            }
        }

        private static async Task Pipe(StreamReader from, string file)
        {
            string? line;
            while ((line = await from.ReadLineAsync()) != null)
                try { await File.AppendAllTextAsync(file, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {line}{Environment.NewLine}"); } catch { }
        }
    }

    /// <summary>The harbor's own log: state/harbor.log in the island's home.</summary>
    public sealed class FileLogProvider : ILoggerProvider
    {
        private readonly string file;
        private readonly object gate = new();
        public FileLogProvider(string file) { this.file = file; Directory.CreateDirectory(Path.GetDirectoryName(file)!); }
        public ILogger CreateLogger(string category) => new FileLogger(this, category);
        public void Dispose() { }
        private sealed class FileLogger(FileLogProvider p, string category) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
            public bool IsEnabled(LogLevel level) => level >= LogLevel.Information && !category.StartsWith("Microsoft");
            public void Log<TState>(LogLevel level, EventId id, TState state, Exception? ex, Func<TState, Exception?, string> fmt)
            {
                if (!IsEnabled(level)) return;
                lock (p.gate) { try { File.AppendAllText(p.file, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {level,-11} {fmt(state, ex)}{(ex is null ? "" : " " + ex.Message)}{Environment.NewLine}"); } catch { } }
            }
        }
    }
}

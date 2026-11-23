// A ferry's side of the island protocol (docs/protocol.md): JSON-RPC 2.0, one message per line, over a named pipe.
//
// Where to connect: the harbor's front door (\\.\pipe\pandora-island by default) when the island runs as a service,
// or, when the core runs in a console for development, the core's own door named in <home>/state/core.json. Either way
// the ferry says island.hello with the island's token (from that same core.json) before anything else is answered.

using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Islands.Client;

public sealed class IslandError(int code, string message) : Exception(message)
{
    public int Code { get; } = code;
}

/// <summary>Where an island is, and how to say hello to it.</summary>
public sealed record IslandAddress(string Home, string Pipe = "pandora-island")
{
    /// <summary>The token and the core's own door, from &lt;home&gt;/state/core.json.</summary>
    public (string Token, string? CorePipe) ReadCore()
    {
        var file = Path.Combine(Home, "state", "core.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(file));
        var token = doc.RootElement.GetProperty("token").GetString() ?? throw new InvalidDataException("core.json has no token");
        var ep = doc.RootElement.TryGetProperty("endpoint", out var e) ? e.GetString() : null;
        const string prefix = @"\\.\pipe\";
        return (token, ep != null && ep.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? ep[prefix.Length..] : null);
    }

    /// <summary>The harbor's door for this island, from &lt;home&gt;/state/harbor.json (each island has its own), or null.</summary>
    public string? HarborPipe()
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(Home, "state", "harbor.json")));
            var p = doc.RootElement.GetProperty("pipe").GetString() ?? "";
            const string prefix = @"\\.\pipe\";
            return p.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? p[prefix.Length..] : null;
        }
        catch { return null; }
    }
}

public sealed class IslandClient : IAsyncDisposable
{
    private readonly NamedPipeClientStream pipe;
    private readonly StreamReader reader;
    private readonly SemaphoreSlim writeLock = new(1, 1);
    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonElement>> waiting = new();
    private readonly CancellationTokenSource closing = new();
    private int next;
    private readonly Task pump;

    /// <summary>A notification from the island: (method, params). Raised on a background thread.</summary>
    public event Action<string, JsonElement>? Notified;
    /// <summary>The connection ended.</summary>
    public event Action<Exception?>? Closed;

    public string Door { get; }

    private IslandClient(NamedPipeClientStream pipe, string door)
    {
        this.pipe = pipe;
        Door = door;
        reader = new StreamReader(pipe, new UTF8Encoding(false), false, 1 << 16, leaveOpen: true);
        pump = Task.Run(Pump);
    }

    /// <summary>Open a pipe by name (the part after \\.\pipe\).</summary>
    public static async Task<IslandClient> ConnectPipeAsync(string name, int timeoutMs = 3000, CancellationToken ct = default)
    {
        var p = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
        try { await p.ConnectAsync(timeoutMs, ct); }
        catch { await p.DisposeAsync(); throw; }
        return new IslandClient(p, name);
    }

    /// <summary>
    /// Connect to an island and say hello: through the harbor's door if it's open, else straight to the core's own door
    /// (a core running in a console). Returns the client and the hello's answer.
    /// </summary>
    public static async Task<(IslandClient Client, JsonElement Hello)> ConnectAsync(IslandAddress where, string ferryName, string ferryVersion, string asWho, CancellationToken ct = default)
    {
        var (token, corePipe) = where.ReadCore();
        // the door this island's harbor says it opened, then the one named in settings, then the core's own
        var doors = new[] { where.HarborPipe(), where.Pipe, corePipe }.Where(d => !string.IsNullOrEmpty(d)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        IslandClient? c = null;
        Exception? last = null;
        foreach (var d in doors)
        {
            try { c = await ConnectPipeAsync(d!, d == corePipe ? 3000 : 1500, ct); break; }
            catch (Exception e) when (e is not OperationCanceledException) { last = e; }
        }
        if (c is null) throw last ?? new IOException("no door to try");
        try
        {
            var hello = await c.CallAsync("island.hello", new JsonObject
            {
                ["token"] = token,
                ["ferry"] = new JsonObject { ["name"] = ferryName, ["version"] = ferryVersion },
                ["protocol"] = "islands/0.1",
                ["as"] = asWho,
            }, ct);
            return (c, hello);
        }
        catch { await c.DisposeAsync(); throw; }
    }

    private async Task Pump()
    {
        Exception? why = null;
        try
        {
            string? line;
            while ((line = await reader.ReadLineAsync(closing.Token)) != null)
            {
                if (line.Length == 0) continue;
                JsonElement m;
                try { m = JsonDocument.Parse(line).RootElement.Clone(); } catch { continue; }
                if (m.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.Number && waiting.TryRemove(id.GetInt32(), out var w))
                {
                    if (m.TryGetProperty("error", out var err)) w.TrySetException(new IslandError(err.GetProperty("code").GetInt32(), err.GetProperty("message").GetString() ?? "error"));
                    else w.TrySetResult(m.TryGetProperty("result", out var r) ? r : default);
                }
                else if (m.TryGetProperty("method", out var method))
                {
                    var p = m.TryGetProperty("params", out var pp) ? pp : default;
                    try { Notified?.Invoke(method.GetString() ?? "", p); } catch { }
                }
            }
        }
        catch (Exception e) when (e is not OperationCanceledException) { why = e; }
        catch (OperationCanceledException) { }
        foreach (var w in waiting.Values) w.TrySetException(new IOException("the island closed the connection"));
        waiting.Clear();
        Closed?.Invoke(why);
    }

    /// <summary>One call; the answer's `result`, or an IslandError with the island's code and reason.</summary>
    public async Task<JsonElement> CallAsync(string method, JsonObject? args = null, CancellationToken ct = default)
    {
        var id = Interlocked.Increment(ref next);
        var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        waiting[id] = tcs;
        var msg = new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method, ["params"] = args ?? new JsonObject() };
        var bytes = Encoding.UTF8.GetBytes(msg.ToJsonString() + "\n");
        await writeLock.WaitAsync(ct);
        try { await pipe.WriteAsync(bytes, ct); await pipe.FlushAsync(ct); }
        catch { waiting.TryRemove(id, out _); throw; }
        finally { writeLock.Release(); }
        using var reg = ct.Register(() => tcs.TrySetCanceled(ct));
        return await tcs.Task;
    }

    public bool Connected => pipe.IsConnected && !pump.IsCompleted;

    public async ValueTask DisposeAsync()
    {
        closing.Cancel();
        try { pipe.Dispose(); } catch { }
        try { await pump; } catch { }
    }
}

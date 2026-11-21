// The ferry's client against the real core: a node core in a temporary home, spoken to over its own pipe.
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Islands.Client;
using Xunit;

namespace Islands.Client.Tests;

public sealed class CoreFixture : IAsyncLifetime
{
    public string Home { get; } = Directory.CreateTempSubdirectory("island-ferry-").FullName;
    private Process? core;

    public static string Repo()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d != null && !File.Exists(Path.Combine(d.FullName, "core", "bin", "island.ts"))) d = d.Parent;
        return d?.FullName ?? throw new InvalidOperationException("can't find the repo (core/bin/island.ts)");
    }

    public async Task InitializeAsync()
    {
        var psi = new ProcessStartInfo(Environment.GetEnvironmentVariable("ISLAND_NODE") ?? "node") { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        foreach (var a in new[] { Path.Combine(Repo(), "core", "bin", "island.ts"), Home, "--name", "Ferry test island" }) psi.ArgumentList.Add(a);
        psi.Environment["ISLAND_STOP_ON_STDIN_END"] = "1";
        core = Process.Start(psi)!;
        var json = Path.Combine(Home, "state", "core.json");
        var sw = Stopwatch.StartNew();
        while (!File.Exists(json)) { if (sw.Elapsed > TimeSpan.FromSeconds(20)) throw new TimeoutException("the core didn't come up: " + await core.StandardError.ReadToEndAsync()); await Task.Delay(100); }
    }

    public async Task DisposeAsync()
    {
        if (core is { HasExited: false }) { core.StandardInput.Close(); if (!core.WaitForExit(10000)) core.Kill(true); }
        await Task.CompletedTask;
    }

    public IslandAddress Address => new(Home, Pipe: "no-harbor-here-" + Guid.NewGuid().ToString("n")[..8]);
}

public sealed class ClientTests(CoreFixture island) : IClassFixture<CoreFixture>
{
    private static JsonObject O(params (string k, JsonNode? v)[] kv) { var o = new JsonObject(); foreach (var (k, v) in kv) o[k] = v; return o; }

    [Fact]
    public async Task Without_a_harbor_it_finds_the_core_door_and_says_hello()
    {
        var (c, hello) = await IslandClient.ConnectAsync(island.Address, "wpf", "test", "Mrrowr-murrr");
        await using var _ = c;
        Assert.Equal("Ferry test island", hello.GetProperty("island").GetProperty("name").GetString());
        Assert.Equal("islands/0.1", hello.GetProperty("island").GetProperty("protocol").GetString());
        Assert.Equal("Mrrowr-murrr", hello.GetProperty("as").GetString());
    }

    [Fact]
    public async Task A_wrong_token_gets_nothing()
    {
        var (_, corePipe) = island.Address.ReadCore();
        await using var c = await IslandClient.ConnectPipeAsync(corePipe!);
        var e = await Assert.ThrowsAsync<IslandError>(() => c.CallAsync("vault.list"));
        Assert.Equal(-32000, e.Code);
        e = await Assert.ThrowsAsync<IslandError>(() => c.CallAsync("island.hello", O(("token", "nope"))));
        Assert.Equal(-32000, e.Code);
    }

    [Fact]
    public async Task Vault_and_chats_round_trip()
    {
        var (c, _) = await IslandClient.ConnectAsync(island.Address, "wpf", "test", "Mrrowr-murrr");
        await using var _c = c;
        await c.CallAsync("vault.write", O(("path", "/Pandora/from-the-window.md"), ("text", "written from WPF ✨")));
        var r = await c.CallAsync("vault.read", O(("path", "/Pandora/from-the-window.md")));
        Assert.Equal("written from WPF ✨", r.GetProperty("text").GetString());
        Assert.Equal("written from WPF ✨", File.ReadAllText(Path.Combine(island.Home, "vault", "Pandora", "from-the-window.md")));
        var chat = (await c.CallAsync("chat.create", O(("title", "From the window")))).GetProperty("chat").GetProperty("id").GetString()!;
        await c.CallAsync("chat.post", O(("id", chat), ("content", "Hello, island.")));
        var open = await c.CallAsync("chat.open", O(("id", chat)));
        Assert.Equal("Hello, island.", open.GetProperty("messages")[0].GetProperty("content").GetString());
        var notFound = await Assert.ThrowsAsync<IslandError>(() => c.CallAsync("vault.read", O(("path", "/nope.md"))));
        Assert.Equal(-32001, notFound.Code);
    }

    [Fact]
    public async Task Events_arrive_from_the_last_seq_then_live()
    {
        var (a, helloA) = await IslandClient.ConnectAsync(island.Address, "wpf", "test", "Mrrowr-murrr");
        await using var _a = a;
        var since = helloA.GetProperty("seq").GetInt32();
        var (b, _) = await IslandClient.ConnectAsync(island.Address, "cli", "test", "pandora");
        await using var _b = b;
        await b.CallAsync("vault.write", O(("path", "/before.md"), ("text", "while the window wasn't listening")));
        var got = new List<JsonElement>();
        var two = new TaskCompletionSource();
        a.Notified += (m, p) => { if (m != "event") return; lock (got) { if (p.GetProperty("kind").GetString() == "vault.write") got.Add(p.Clone()); if (got.Count == 2) two.TrySetResult(); } };
        await a.CallAsync("events.subscribe", O(("fromSeq", since), ("kinds", new JsonArray("vault."))));
        await b.CallAsync("vault.write", O(("path", "/after.md"), ("text", "live")));
        await two.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(new[] { "/before.md", "/after.md" }, got.Select(e => e.GetProperty("subject").GetString()).ToArray());
        Assert.All(got, e => Assert.Equal("pandora", e.GetProperty("actor").GetString()));
    }
}

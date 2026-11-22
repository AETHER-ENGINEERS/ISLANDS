// The WPF ferry: one window onto the island. It shows and sends; the island does all the thinking.
// Closing it closes only the ferry: her turns, threads and schedules keep going on the island, and when the window
// comes back it catches up from the island's log (events.subscribe from the last seq it saw).

using System.Collections.ObjectModel;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Islands.Client;

namespace Islands.Ferry;

public partial class MainWindow : Window
{
    private readonly FerrySettings settings;
    private readonly string? snapshot;
    private string? wantChat;
    private IslandClient? client;
    private int lastSeq;
    private bool closing;

    private readonly ObservableCollection<ChatItem> chats = new();
    private readonly ObservableCollection<Msg> messages = new();
    private readonly ObservableCollection<ThreadItem> threads = new();
    private readonly ObservableCollection<VaultNode> vault = new();
    private readonly ObservableCollection<string> keys = new();
    private string? chatId;
    private LiveMsg? live;
    private string? liveThread;
    private string? openPath;
    private long openMtime;
    private string? hbChat;
    private string? hbThread;
    private bool hbOn;
    private readonly ObservableCollection<ScheduleItem> schedules = new();
    private string? schId;
    private string? schChat;
    private bool schRefreshing;
    private System.Windows.Threading.DispatcherTimer? whenTimer;

    /// <summary>--send: with --snapshot, say this in the chat and wait for her answer before drawing (a check with no person at the screen).</summary>
    public string? SendOnStart { get; init; }

    /// <summary>--tab: open on this tab (chat, vault, heartbeat, schedules, keys), e.g. to snapshot a panel.</summary>
    public string? StartTab { get; init; }

    public MainWindow(FerrySettings settings, string? snapshot = null, string? openChat = null)
    {
        InitializeComponent();
        this.settings = settings;
        this.snapshot = snapshot;
        wantChat = openChat;
        Chats.ItemsSource = chats;
        Messages.ItemsSource = messages;
        Threads.ItemsSource = threads;
        VaultTree.ItemsSource = vault;
        KeyList.ItemsSource = keys;
        SchList.ItemsSource = schedules;
        Editor.TextChanged += (_, _) => SaveBtn.IsEnabled = openPath != null;
        Loaded += async (_, _) => await ConnectLoop();
        // the shrine can change from her other places too (the Atelier), so the Now bar looks again now and then
        var nowTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(60) };
        nowTimer.Tick += (_, _) => { if (client != null) { _ = RefreshNow(); _ = RefreshHeartbeat(); _ = RefreshSchedules(); } };
        nowTimer.Start();
        Closing += (_, _) => { closing = true; _ = client?.DisposeAsync(); };
    }

    // ---------- the connection ----------

    private async Task ConnectLoop()
    {
        while (!closing)
        {
            try
            {
                SetStatus($"Connecting to the island at {settings.Home}…", warn: true);
                var (c, hello) = await IslandClient.ConnectAsync(new IslandAddress(settings.Home, settings.Pipe), "wpf", "0.1", settings.As);
                client = c;
                var gone = new TaskCompletionSource();
                c.Closed += _ => gone.TrySetResult();
                c.Notified += (m, p) => Dispatcher.InvokeAsync(() => OnNotify(m, p));
                await OnConnected(hello);
                if (snapshot != null)
                {
                    if (SendOnStart != null)
                    {
                        var done = new TaskCompletionSource();
                        c.Notified += (m, p) => { if (m == "chat.done") done.TrySetResult(); };
                        Input.Text = SendOnStart; Send(this, new RoutedEventArgs());
                        await Task.WhenAny(done.Task, Task.Delay(60000));
                        await Task.Delay(800);
                    }
                    await Snap(); return;
                }
                await gone.Task;
                if (closing) return;
                client = null;
                SetStatus("The island closed the connection. Reconnecting…", warn: true);
            }
            catch (Exception e)
            {
                if (snapshot != null) { SetStatus("Couldn't reach the island: " + e.Message, bad: true); await Snap(); return; }
                SetStatus($"Can't reach the island yet ({e.Message}). Trying again…", bad: true);
            }
            await Task.Delay(2000);
        }
    }

    private async Task OnConnected(JsonElement hello)
    {
        var name = hello.GetProperty("island").GetProperty("name").GetString() ?? "Island";
        IslandName.Text = name; Title = name;
        var caughtUpFrom = lastSeq;
        if (lastSeq == 0) lastSeq = hello.GetProperty("seq").GetInt32();
        await RefreshStatus();
        await RefreshChats();
        await RefreshThreads();
        await RefreshKeys();
        await RefreshVaultTree();
        await RefreshHeartbeat();
        await RefreshScheduleModels();
        await RefreshSchedules();
        if (schId == null && SchList.SelectedItem == null)
        {
            if (schedules.FirstOrDefault(x => !x.IsHeartbeat) is { } first) SchList.SelectedItem = first;   // opens on her first schedule
            else SchFormFor(null);
        }
        if (StartTab != null) { var t = Tabs.Items.OfType<TabItem>().FirstOrDefault(x => string.Equals(x.Header as string, StartTab, StringComparison.OrdinalIgnoreCase)); if (t != null) Tabs.SelectedItem = t; }
        // anything that happened while the window was away comes now, then everything as it happens
        await Call("events.subscribe", new JsonObject { ["fromSeq"] = caughtUpFrom == 0 ? lastSeq : caughtUpFrom, ["kinds"] = new JsonArray("chat.", "thread.", "vault.", "schedule.", "tool.call") });
        if (wantChat != null) { var c = chats.FirstOrDefault(x => x.Id == wantChat); wantChat = null; if (c != null) Chats.SelectedItem = c; }
        else if (chatId != null) await OpenChat(chatId);
        else if (chats.Count > 0 && Chats.SelectedItem == null) Chats.SelectedItem = chats[0];
        Dot.Fill = (Brush)FindResource("Accent");
        SetStatus($"Connected as {settings.As}, through {(client!.Door.StartsWith("island-core-") ? "the core's own door (no harbor running)" : "the harbor's door")}.");
    }

    private async Task<JsonElement> Call(string method, JsonObject? args = null)
    {
        var c = client ?? throw new InvalidOperationException("not connected");
        return await c.CallAsync(method, args);
    }

    private void SetStatus(string text, bool warn = false, bool bad = false)
    {
        Status.Text = text;
        Dot.Fill = (Brush)FindResource(bad ? "Bad" : warn ? "Warn" : "Accent");
    }

    // ---------- what the island says ----------

    private void OnNotify(string method, JsonElement p)
    {
        switch (method)
        {
            case "event":
                lastSeq = Math.Max(lastSeq, p.GetProperty("seq").GetInt32());
                var kind = p.GetProperty("kind").GetString() ?? "";
                if (kind is "chat.create" or "chat.rename") _ = RefreshChats();
                else if (kind == "chat.message" && p.TryGetProperty("chat", out var ch) && ch.GetString() == chatId && live == null) _ = OpenChat(chatId!);
                else if (kind.StartsWith("vault.") && Tabs.SelectedIndex == 1) _ = RefreshVaultTree();
                else if (kind == "tool.call" && Str(p, "tool")?.EndsWith("mode_set") == true) _ = RefreshNow();
                if (kind.StartsWith("schedule.")) _ = RefreshSchedules();
                if (kind.StartsWith("schedule.") && Str(p, "schedule") == "heartbeat") { _ = RefreshHeartbeat(); _ = RefreshStatus(); }
                else if (kind == "chat.message" && hbChat != null && Str(p, "chat") == hbChat) _ = RefreshHeartbeat();
                break;
            case "chat.delta":
                if (Str(p, "chat") != chatId) return;
                if (live == null || liveThread != Str(p, "thread")) { live = new LiveMsg(); liveThread = Str(p, "thread"); messages.Add(live); }
                if (p.TryGetProperty("content", out var c)) { live.Text += c.GetString(); live.Status = "writing…"; }
                if (p.TryGetProperty("reasoning", out var r)) live.Reasoning += r.GetString();
                if (p.TryGetProperty("tool", out var t)) live.Status = $"used {t.GetString()}";
                if (p.TryGetProperty("fallback", out var fb)) live.Status = $"{Str(fb, "from")} couldn't answer; asking the next model…";
                if (p.TryGetProperty("message", out _)) { messages.Remove(live); live = null; _ = OpenChat(chatId!); }
                ScrollDown();
                break;
            case "chat.done":
                if (Str(p, "chat") == chatId) { if (live != null) { messages.Remove(live); live = null; } _ = OpenChat(chatId!); }
                Busy(false);
                break;
            case "thread":
                var id = Str(p, "id") ?? "";
                var item = threads.FirstOrDefault(x => x.Id == id);
                if (item == null) { item = new ThreadItem { Id = id, Chat = Str(p, "chat") }; threads.Insert(0, item); }
                item.Title = Str(p, "title") ?? ""; item.Status = Str(p, "status") ?? ""; item.Progress = item.Running ? Str(p, "progress") ?? "" : Str(p, "error") ?? "";
                if (item.Chat == chatId) Busy(item.Running);
                if (hbChat != null && item.Chat == hbChat) _ = RefreshHeartbeat();
                if (item.Chat != null && schedules.Any(x => x.Chat == item.Chat)) _ = RefreshSchedules();
                while (threads.Count > 30) threads.RemoveAt(threads.Count - 1);
                break;
            case "notice":
                NoticeText.Text = $"{Str(p, "from")}: {Str(p, "text")}";
                NoticeBar.Visibility = Visibility.Visible;
                if (p.TryGetProperty("urgent", out var u) && u.ValueKind == JsonValueKind.True) { Activate(); System.Media.SystemSounds.Exclamation.Play(); }
                break;
        }
    }

    private static string? Str(JsonElement e, string k) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    // ---------- status, chats, threads ----------

    private async Task RefreshStatus()
    {
        var s = await Call("island.status");
        var m = s.GetProperty("models");
        Model.Text = $"model: {m.GetProperty("default").GetString()}" + (s.TryGetProperty("heartbeat", out var hb) && hb.ValueKind == JsonValueKind.True ? "  ·  heartbeat on" : "");
        await RefreshNow();
    }

    // ---------- the Now bar ----------

    /// <summary>Her mode and tone, from the mode shrine (the island's now.get: the same words her turns see).</summary>
    private async Task RefreshNow()
    {
        try
        {
            var now = await Call("now.get");
            var shrine = now.GetProperty("context").EnumerateArray().FirstOrDefault(c => Str(c, "tool")?.EndsWith("mode_get") == true);
            if (shrine.ValueKind != JsonValueKind.Object) { Shrine.Visibility = Visibility.Collapsed; Mode.Text = ""; return; }
            var text = Str(shrine, "text") ?? "";
            Mode.Text = "";
            try
            {
                using var d = JsonDocument.Parse(text);
                var m = d.RootElement;
                ShrineEmoji.Text = Str(m, "emoji") ?? "";
                ShrineMode.Text = Str(m, "mode") ?? "";
                ShrineTone.Text = Str(m, "tone") is { Length: > 0 } tone ? "  ·  " + tone : "";
                var since = m.TryGetProperty("since", out var s) && s.ValueKind == JsonValueKind.Number ? DateTimeOffset.FromUnixTimeMilliseconds(s.GetInt64()).LocalDateTime : (DateTime?)null;
                Shrine.ToolTip = "Her mode, from the mode shrine" + (Str(m, "set_by") is { Length: > 0 } by ? $"{Environment.NewLine}set by {by}" : "") + (since is { } t ? $", {When(t.ToUniversalTime().ToString("o"))}" : "");
            }
            catch (JsonException)
            {
                // not the shrine's usual shape: show what it says, as she'd read it
                ShrineEmoji.Text = ""; ShrineMode.Text = text.Length > 80 ? text[..80] + "…" : text; ShrineTone.Text = ""; Shrine.ToolTip = text;
            }
            Shrine.Visibility = Visibility.Visible;
        }
        catch { Shrine.Visibility = Visibility.Collapsed; }
    }

    private async Task RefreshChats()
    {
        var r = await Call("chat.list");
        var keep = (Chats.SelectedItem as ChatItem)?.Id ?? chatId;
        chats.Clear();
        foreach (var c in r.GetProperty("chats").EnumerateArray())
            chats.Add(new ChatItem { Id = Str(c, "id")!, Title = Str(c, "title") ?? "", When = When(Str(c, "updated")) });
        if (keep != null) { var again = chats.FirstOrDefault(x => x.Id == keep); if (again != null) Chats.SelectedItem = again; }
    }

    private static string When(string? iso) => DateTime.TryParse(iso, out var t) ? t.ToLocalTime().ToString(t.ToLocalTime().Date == DateTime.Today ? "HH:mm" : "d MMM, HH:mm") : "";

    private async Task RefreshThreads()
    {
        var r = await Call("threads.list", new JsonObject { ["limit"] = 30 });
        threads.Clear();
        foreach (var t in r.GetProperty("threads").EnumerateArray())
            threads.Add(new ThreadItem { Id = Str(t, "id")!, Chat = Str(t, "chat"), Title = Str(t, "title") ?? "", Status = Str(t, "status") ?? "", Progress = Str(t, "status") == "running" ? Str(t, "progress") ?? "" : Str(t, "error") ?? "" });
    }

    private async void ChatPicked(object sender, SelectionChangedEventArgs e)
    {
        if (Chats.SelectedItem is ChatItem c && c.Id != chatId) await OpenChat(c.Id);
    }

    private async Task OpenChat(string id)
    {
        chatId = id;
        JsonElement r;
        try { r = await Call("chat.open", new JsonObject { ["id"] = id }); } catch (Exception e) { SetStatus("Couldn't open that chat: " + e.Message, bad: true); return; }
        messages.Clear();
        foreach (var m in r.GetProperty("messages").EnumerateArray())
        {
            var role = Str(m, "role"); var text = Str(m, "content") ?? ""; var n = m.GetProperty("n").GetInt32(); var by = Str(m, "by") ?? "";
            if (role == "user") messages.Add(new PersonMsg { N = n, By = by, Text = text });
            else if (role == "assistant")
            {
                if (text.Length > 0 || !m.TryGetProperty("tool_calls", out _)) messages.Add(new HerMsg { N = n, By = by, Text = text, Reasoning = Str(m, "reasoning_content"), Model = Str(m, "model") ?? "" });
                else if (Str(m, "reasoning_content") is { Length: > 0 } rs) messages.Add(new HerMsg { N = n, By = by, Text = "", Reasoning = rs, Model = Str(m, "model") ?? "" });
            }
            else if (role == "tool") messages.Add(new ToolMsg { N = n, By = by, Tool = Str(m, "name") ?? "tool", Text = text, Failed = text.StartsWith("Error:") });
            else messages.Add(new NoteMsg { N = n, By = by, Text = text });
        }
        if (live != null && liveThread != null) messages.Add(live);
        EmptyChat.Visibility = Visibility.Collapsed;
        Busy(threads.Any(t => t.Chat == id && t.Running));
        ScrollDown();
    }

    private void ScrollDown() => Dispatcher.InvokeAsync(() => MsgScroll.ScrollToEnd(), System.Windows.Threading.DispatcherPriority.Background);

    private void Busy(bool on)
    {
        StopBtn.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
        SendBtn.IsEnabled = !on;
    }

    private async void NewChat(object sender, RoutedEventArgs e)
    {
        try
        {
            var r = await Call("chat.create", new JsonObject());
            var id = r.GetProperty("chat").GetProperty("id").GetString()!;
            await RefreshChats();
            Chats.SelectedItem = chats.FirstOrDefault(x => x.Id == id);
            Input.Focus();
        }
        catch (Exception ex) { SetStatus("Couldn't make a chat: " + ex.Message, bad: true); }
    }

    private void InputKey(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && Keyboard.Modifiers == ModifierKeys.Control) { e.Handled = true; Send(sender, e); }
    }

    private async void Send(object sender, RoutedEventArgs e)
    {
        var text = Input.Text.Trim();
        if (text.Length == 0) return;
        try
        {
            if (chatId == null) { var r = await Call("chat.create", new JsonObject { ["title"] = text.Length > 60 ? text[..60] + "…" : text }); chatId = r.GetProperty("chat").GetProperty("id").GetString(); await RefreshChats(); }
            await Call("chat.send", new JsonObject { ["id"] = chatId, ["content"] = text });
            Input.Clear();
            Busy(true);
            await OpenChat(chatId!);
            live = new LiveMsg(); liveThread = null; messages.Add(live); ScrollDown();
        }
        catch (IslandError ex) when (ex.Code == -32003) { SetStatus("She's already answering in this chat. Wait, or stop that turn.", warn: true); }
        catch (Exception ex) { SetStatus("Couldn't send: " + ex.Message, bad: true); }
    }

    private async void StopTurn(object sender, RoutedEventArgs e)
    {
        foreach (var t in threads.Where(t => t.Chat == chatId && t.Running).ToList())
            try { await Call("thread.cancel", new JsonObject { ["id"] = t.Id }); } catch { }
    }

    private async void StopThread(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: string id }) try { await Call("thread.cancel", new JsonObject { ["id"] = id }); } catch (Exception ex) { SetStatus(ex.Message, bad: true); }
    }

    private void DismissNotice(object sender, RoutedEventArgs e) => NoticeBar.Visibility = Visibility.Collapsed;

    // ---------- the heartbeat panel ----------

    /// <summary>Her heartbeat as the island sees it: how often, the last beat and what it came to, the next one.</summary>
    private async Task RefreshHeartbeat()
    {
        JsonElement h;
        try { h = await Call("heartbeat.status"); } catch { return; }
        var configured = h.TryGetProperty("configured", out var cf) ? cf.ValueKind == JsonValueKind.True : h.TryGetProperty("enabled", out var en) && en.ValueKind == JsonValueKind.True;
        hbOn = h.TryGetProperty("enabled", out var on) && on.ValueKind == JsonValueKind.True;
        hbChat = Str(h, "chat");
        hbThread = Str(h, "running");
        HbFacts.Visibility = configured ? Visibility.Visible : Visibility.Collapsed;
        HbToggleBtn.Visibility = HbNowBtn.Visibility = configured ? Visibility.Visible : Visibility.Collapsed;
        HbStopBtn.Visibility = hbThread != null ? Visibility.Visible : Visibility.Collapsed;
        if (!configured)
        {
            HbState.Text = "Her heartbeat isn't set up on this island yet. It starts once config/island.json has heartbeat.every (e.g. \"every 30m\").";
            HbState.Foreground = (Brush)FindResource("Dim");
            HbResultHead.Visibility = HbResultBox.Visibility = Visibility.Collapsed;
            return;
        }
        HbState.Text = hbThread != null ? "Beating now…" : hbOn ? "Beating" : "Paused";
        HbState.Foreground = (Brush)FindResource(hbThread != null ? "Accent" : hbOn ? "Ink" : "Warn");
        HbToggleBtn.Content = hbOn ? "Pause" : "Resume";
        HbToggleBtn.ToolTip = hbOn ? "Stop the beats coming round (its config stays as it is)" : "Let the beats come round again, from the next one";
        HbNowBtn.IsEnabled = hbThread == null;
        HbEvery.Text = Str(h, "every") ?? "";
        HbModel.Text = Str(h, "model") ?? "";
        HbLast.Text = Str(h, "lastRun") is { } lr ? When(lr) + "  (" + Ago(lr) + ")" : "not yet";
        var how = Str(h, "lastStatus");
        HbHow.Text = hbThread != null ? "running" : how ?? "—";
        HbHow.Foreground = (Brush)FindResource(how?.StartsWith("failed") == true ? "Bad" : how?.StartsWith("skipped") == true ? "Warn" : "Ink");
        HbNext.Text = !hbOn ? "paused" : Str(h, "next") is { } nx ? When(nx) + "  (" + Until(nx) + ")" : "—";
        if (h.TryGetProperty("result", out var r) && r.ValueKind == JsonValueKind.Object && Str(r, "text") is { Length: > 0 } text)
        {
            if (HbResult.Markdown != text) HbResult.Markdown = text;
            HbResultMeta.Text = "   " + When(Str(r, "at")) + (Str(r, "model") is { Length: > 0 } m ? " · " + m : "");
            HbResultHead.Visibility = HbResultBox.Visibility = Visibility.Visible;
        }
        else HbResultHead.Visibility = HbResultBox.Visibility = Visibility.Collapsed;
    }

    private static string Ago(string iso)
    {
        if (!DateTime.TryParse(iso, out var t)) return "";
        var d = DateTime.Now - t.ToLocalTime();
        return d.TotalMinutes < 1 ? "just now" : d.TotalHours < 1 ? $"{(int)d.TotalMinutes} min ago" : d.TotalDays < 1 ? $"{(int)d.TotalHours} h {d.Minutes} min ago" : $"{(int)d.TotalDays} days ago";
    }

    private static string Until(string iso)
    {
        if (!DateTime.TryParse(iso, out var t)) return "";
        var d = t.ToLocalTime() - DateTime.Now;
        return d.TotalMinutes < 1 ? "in under a minute" : d.TotalHours < 1 ? $"in {(int)Math.Ceiling(d.TotalMinutes)} min" : $"in {(int)d.TotalHours} h {d.Minutes} min";
    }

    private async void HbToggle(object sender, RoutedEventArgs e)
    {
        try { await Call("heartbeat.set", new JsonObject { ["on"] = !hbOn }); await RefreshHeartbeat(); await RefreshStatus(); SetStatus(hbOn ? "Her heartbeat is on again; it beats next at its next time." : "Her heartbeat is paused. Its settings are kept."); }
        catch (Exception ex) { SetStatus("Couldn't change the heartbeat: " + ex.Message, bad: true); }
    }

    private async void HbBeatNow(object sender, RoutedEventArgs e)
    {
        try { await Call("schedule.run", new JsonObject { ["id"] = "heartbeat" }); await RefreshHeartbeat(); SetStatus("One heartbeat, now."); }
        catch (IslandError ex) when (ex.Code == -32003) { await RefreshHeartbeat(); SetStatus("It's still beating from last time, or had nothing to do (see How it went).", warn: true); }
        catch (Exception ex) { SetStatus("Couldn't start a beat: " + ex.Message, bad: true); }
    }

    private async void HbStop(object sender, RoutedEventArgs e)
    {
        if (hbThread == null) return;
        try { await Call("thread.cancel", new JsonObject { ["id"] = hbThread }); } catch (Exception ex) { SetStatus(ex.Message, bad: true); }
    }

    private async void HbOpenChat(object sender, RoutedEventArgs e)
    {
        if (hbChat == null) return;
        Tabs.SelectedIndex = 0;
        var c = chats.FirstOrDefault(x => x.Id == hbChat);
        if (c != null) Chats.SelectedItem = c; else await OpenChat(hbChat);
    }

    // ---------- the schedules editor ----------

    /// <summary>Her schedules from the island (the heartbeat first, when it's set up), keeping what's picked.</summary>
    private async Task RefreshSchedules()
    {
        JsonElement r;
        try { r = await Call("schedule.list"); } catch { return; }
        var keep = (SchList.SelectedItem as ScheduleItem)?.Id ?? schId;
        schRefreshing = true;
        try
        {
            schedules.Clear();
            foreach (var s in r.GetProperty("schedules").EnumerateArray())
            {
                var enabled = s.TryGetProperty("enabled", out var en) && en.ValueKind == JsonValueKind.True;
                var running = Str(s, "running"); var next = Str(s, "next"); var how = Str(s, "lastStatus"); var when = Str(s, "when") ?? "";
                var sub = (enabled ? when : "off · " + when) + (running != null ? " · running now" : enabled && next != null ? " · next " + When(next) : "") + (how?.StartsWith("failed") == true ? " · last run failed" : "");
                schedules.Add(new ScheduleItem
                {
                    Id = Str(s, "id")!, Name = Str(s, "name") ?? "", When = when, Prompt = Str(s, "prompt"), Command = Str(s, "command"), Model = Str(s, "model"),
                    Chat = Str(s, "chat"), Enabled = enabled, LastRun = Str(s, "lastRun"), LastStatus = how, Next = next, Running = running,
                    Line = Str(s, "name") ?? "", Sub = sub,
                });
            }
            SchEmpty.Visibility = schedules.Any(x => !x.IsHeartbeat) ? Visibility.Collapsed : Visibility.Visible;
            var again = keep == null ? null : schedules.FirstOrDefault(x => x.Id == keep);
            if (again != null) { SchList.SelectedItem = again; SchFactsFrom(again); }
            else if (schId != null) SchFormFor(null);   // it was taken away elsewhere
        }
        finally { schRefreshing = false; }
    }

    private async Task RefreshScheduleModels()
    {
        try
        {
            var m = await Call("models.list");
            var roles = m.TryGetProperty("roles", out var ro) ? ro : default;
            var own = Str(roles, "schedules") ?? Str(m, "default") ?? "";
            var pick = (SchModel.SelectedItem as ComboBoxItem)?.Tag as string ?? "";
            SchModel.Items.Clear();
            SchModel.Items.Add(new ComboBoxItem { Content = $"the island's model for schedules ({own})", Tag = "" });
            foreach (var x in m.GetProperty("models").EnumerateArray())
                if (Str(x, "name") is { } n) SchModel.Items.Add(new ComboBoxItem { Content = n + (x.TryGetProperty("ready", out var rd) && rd.ValueKind == JsonValueKind.False ? "  (not ready)" : ""), Tag = n });
            SchPickModel(pick);
        }
        catch { }
    }

    private void SchPickModel(string? name)
    {
        var want = SchModel.Items.OfType<ComboBoxItem>().FirstOrDefault(i => (string)i.Tag == (name ?? ""));
        if (want == null && !string.IsNullOrEmpty(name)) { want = new ComboBoxItem { Content = name + "  (not in this island's models)", Tag = name }; SchModel.Items.Add(want); }
        SchModel.SelectedItem = want ?? SchModel.Items.OfType<ComboBoxItem>().FirstOrDefault();
    }

    private void SchPicked(object sender, SelectionChangedEventArgs e)
    {
        if (schRefreshing) return;
        if (SchList.SelectedItem is ScheduleItem s) SchFormFor(s);
    }

    private void SchNew(object sender, RoutedEventArgs e)
    {
        SchList.SelectedItem = null;
        SchFormFor(null);
        SchName.Focus();
    }

    /// <summary>The form for one schedule, or a blank one for a new schedule.</summary>
    private void SchFormFor(ScheduleItem? s)
    {
        schId = s?.Id;
        var hb = s?.IsHeartbeat == true;
        SchTitle.Text = s == null ? "NEW SCHEDULE" : hb ? "HEARTBEAT" : "SCHEDULE";
        SchHbNote.Visibility = hb ? Visibility.Visible : Visibility.Collapsed;
        SchName.Text = s?.Name ?? "";
        SchWhen.Text = s?.When ?? "daily 08:30";
        SchIsCommand.IsChecked = s?.Command != null;
        SchIsPrompt.IsChecked = s?.Command == null;
        SchBody.Text = s == null ? "" : hb ? "Her checklist, read fresh from HEARTBEAT.md at each beat." : s.Command ?? s.Prompt ?? "";
        SchPickModel(s?.Model);
        SchOn.IsChecked = s?.Enabled ?? true;
        foreach (var c in new Control[] { SchName, SchWhen, SchBody, SchModel, SchIsPrompt, SchIsCommand, SchOn }) c.IsEnabled = !hb;
        SchSaveBtn.Visibility = SchRemoveBtn.Visibility = SchRunBtn.Visibility = hb ? Visibility.Collapsed : Visibility.Visible;
        SchSaveBtn.Content = s == null ? "Make it" : "Save";
        if (s == null) SchRemoveBtn.Visibility = SchRunBtn.Visibility = Visibility.Collapsed;
        SchFactsFrom(s);
    }

    private void SchFactsFrom(ScheduleItem? s)
    {
        SchFacts.Visibility = s == null ? Visibility.Collapsed : Visibility.Visible;
        schChat = s?.Chat;
        SchChatBtn.Visibility = s?.Chat != null ? Visibility.Visible : Visibility.Collapsed;
        if (s == null) return;
        SchRunBtn.IsEnabled = s.Running == null;
        SchLast.Text = s.LastRun is { } lr ? When(lr) + "  (" + Ago(lr) + ")" : "not yet";
        SchHow.Text = s.Running != null ? "running" : s.LastStatus ?? "—";
        SchHow.Foreground = (Brush)FindResource(s.LastStatus?.StartsWith("failed") == true ? "Bad" : s.LastStatus?.StartsWith("skipped") == true ? "Warn" : "Ink");
        SchNext.Text = !s.Enabled ? "off" : s.Next is { } nx ? When(nx) + "  (" + Until(nx) + ")" : "—";
    }

    private void SchWhenChanged(object sender, TextChangedEventArgs e)
    {
        if (whenTimer == null)
        {
            whenTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(350) };
            whenTimer.Tick += SchCheckWhen;
        }
        whenTimer.Stop(); whenTimer.Start();
    }

    /// <summary>What the time typed means, from the island itself (the same reading its scheduler uses).</summary>
    private async void SchCheckWhen(object? sender, EventArgs e)
    {
        whenTimer?.Stop();
        var when = SchWhen.Text.Trim();
        if (when.Length == 0 || client == null) { SchWhenNext.Text = ""; return; }
        try
        {
            var r = await Call("schedule.when", new JsonObject { ["when"] = when, ["count"] = 3 });
            if (SchWhen.Text.Trim() != when) return;
            var times = r.GetProperty("next").EnumerateArray().Select(x => DateTime.TryParse(x.GetString(), out var t) ? t.ToLocalTime().ToString("ddd d MMM, HH:mm") : "").Where(x => x.Length > 0);
            SchWhenNext.Text = "comes round " + string.Join("  ·  ", times) + "   (cron " + Str(r, "cron") + ")";
            SchWhenNext.Foreground = (Brush)FindResource("Accent");
        }
        catch (Exception ex)
        {
            if (SchWhen.Text.Trim() != when) return;
            SchWhenNext.Text = ex.Message;
            SchWhenNext.Foreground = (Brush)FindResource("Bad");
        }
    }

    private async void SchSave(object sender, RoutedEventArgs e)
    {
        var name = SchName.Text.Trim(); var body = SchBody.Text;
        if (name.Length == 0) { SetStatus("A schedule needs a name.", warn: true); SchName.Focus(); return; }
        if (body.Trim().Length == 0) { SetStatus(SchIsCommand.IsChecked == true ? "Give it a command to run." : "Give it a prompt: what she does when it comes round.", warn: true); SchBody.Focus(); return; }
        var model = (SchModel.SelectedItem as ComboBoxItem)?.Tag as string ?? "";
        var args = new JsonObject { ["name"] = name, ["when"] = SchWhen.Text.Trim(), [SchIsCommand.IsChecked == true ? "command" : "prompt"] = body, ["enabled"] = SchOn.IsChecked == true };
        try
        {
            JsonElement r;
            if (schId == null) { if (model.Length > 0) args["model"] = model; r = await Call("schedule.create", args); }
            else { args["id"] = schId; args["model"] = model; r = await Call("schedule.update", args); }
            schId = Str(r.GetProperty("schedule"), "id");
            await RefreshSchedules();
            if (schedules.FirstOrDefault(x => x.Id == schId) is { } s) { SchList.SelectedItem = s; SchFormFor(s); }
            SetStatus($"\"{name}\" is saved on the island{(SchOn.IsChecked == true ? "" : ", switched off")}.");
        }
        catch (Exception ex) { SetStatus("Couldn't save it: " + ex.Message, bad: true); }
    }

    private async void SchRun(object sender, RoutedEventArgs e)
    {
        if (schId == null) return;
        try { await Call("schedule.run", new JsonObject { ["id"] = schId }); await RefreshSchedules(); SetStatus("Running it once, now."); }
        catch (IslandError ex) when (ex.Code == -32003) { await RefreshSchedules(); SetStatus("It's still running from last time.", warn: true); }
        catch (Exception ex) { SetStatus("Couldn't run it: " + ex.Message, bad: true); }
    }

    private async void SchRemove(object sender, RoutedEventArgs e)
    {
        if (schId == null || schedules.FirstOrDefault(x => x.Id == schId) is not { } s) return;
        if (MessageBox.Show(this, $"Take \"{s.Name}\" away? A copy is kept in the island's trash (trash/schedules.jsonl).", "Remove schedule", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        try { await Call("schedule.delete", new JsonObject { ["id"] = schId }); SchFormFor(null); await RefreshSchedules(); SetStatus($"\"{s.Name}\" is taken away; a copy is in the island's trash."); }
        catch (Exception ex) { SetStatus("Couldn't remove it: " + ex.Message, bad: true); }
    }

    private async void SchOpenChat(object sender, RoutedEventArgs e)
    {
        if (schChat == null) return;
        Tabs.SelectedIndex = 0;
        await RefreshChats();
        var c = chats.FirstOrDefault(x => x.Id == schChat);
        if (c != null) Chats.SelectedItem = c; else await OpenChat(schChat);
    }

    private void SchGoHeartbeat(object sender, RoutedEventArgs e)
    {
        var t = Tabs.Items.OfType<TabItem>().FirstOrDefault(x => x.Header as string == "Heartbeat");
        if (t != null) Tabs.SelectedItem = t;
    }

    // ---------- the vault ----------

    private async void RefreshVault(object sender, RoutedEventArgs e) => await RefreshVaultTree();

    private async Task RefreshVaultTree()
    {
        JsonElement r;
        try { r = await Call("vault.list", new JsonObject { ["path"] = "/", ["recursive"] = true }); } catch { return; }
        var root = new Dictionary<string, VaultNode> { ["/"] = new VaultNode { Path = "/", Name = "/", Dir = true } };
        foreach (var e in r.GetProperty("entries").EnumerateArray())
        {
            var p = Str(e, "path")!; var dir = e.GetProperty("dir").GetBoolean();
            var parent = p[..Math.Max(1, p.LastIndexOf('/'))];
            var node = new VaultNode { Path = p, Name = p[(p.LastIndexOf('/') + 1)..], Dir = dir };
            root[p] = node;
            if (root.TryGetValue(parent, out var up)) up.Children.Add(node);
        }
        vault.Clear();
        foreach (var n in root["/"].Children.OrderBy(x => !x.Dir).ThenBy(x => x.Name)) vault.Add(n);
    }

    private async void VaultPicked(object sender, RoutedPropertyChangedEventArgs<object> e)
    {
        if (e.NewValue is not VaultNode { Dir: false } n) return;
        try
        {
            var r = await Call("vault.read", new JsonObject { ["path"] = n.Path });
            openPath = n.Path; openMtime = r.GetProperty("mtime").GetInt64();
            Editor.Text = Str(r, "text") ?? "";
            FilePath.Text = n.Path;
            SaveBtn.IsEnabled = false;
        }
        catch (Exception ex) { SetStatus("Couldn't open it: " + ex.Message, bad: true); }
    }

    private async void SaveFile(object sender, RoutedEventArgs e)
    {
        if (openPath == null) return;
        try
        {
            var r = await Call("vault.write", new JsonObject { ["path"] = openPath, ["text"] = Editor.Text, ["ifMtime"] = openMtime });
            openMtime = r.GetProperty("mtime").GetInt64();
            SaveBtn.IsEnabled = false;
            SetStatus($"Saved {openPath}.");
        }
        catch (IslandError ex) when (ex.Code == -32003) { SetStatus($"{openPath} changed on the island since you opened it. Copy your text, reopen the file, and merge.", warn: true); }
        catch (Exception ex) { SetStatus("Couldn't save: " + ex.Message, bad: true); }
    }

    // ---------- keys ----------

    private async Task RefreshKeys()
    {
        var r = await Call("keys.list");
        keys.Clear();
        foreach (var k in r.GetProperty("keys").EnumerateArray()) keys.Add($"{Str(k, "name")}   ({Str(k, "backend")})");
    }

    private async void SetKey(object sender, RoutedEventArgs e)
    {
        var name = KeyName.Text.Trim();
        if (name.Length == 0 || KeyValue.Password.Length == 0) return;
        try
        {
            await Call("keys.set", new JsonObject { ["name"] = name, ["value"] = KeyValue.Password });
            KeyValue.Clear(); KeyName.Clear();
            await RefreshKeys();
            SetStatus($"{name} is in, sealed to the island's account.");
        }
        catch (Exception ex) { SetStatus("Couldn't put it in: " + ex.Message, bad: true); }
    }

    // ---------- --snapshot: draw the window to a PNG and close (for checks without a person at the screen) ----------

    private async Task Snap()
    {
        await Task.Delay(1200);
        UpdateLayout();
        var dpi = VisualTreeHelper.GetDpi(this);
        var content = (FrameworkElement)Content;
        var bmp = new RenderTargetBitmap((int)(content.ActualWidth * dpi.DpiScaleX), (int)(content.ActualHeight * dpi.DpiScaleY), dpi.PixelsPerInchX, dpi.PixelsPerInchY, PixelFormats.Pbgra32);
        bmp.Render(content);
        var enc = new PngBitmapEncoder();
        enc.Frames.Add(BitmapFrame.Create(bmp));
        using (var f = File.Create(snapshot!)) enc.Save(f);
        Close();
    }
}

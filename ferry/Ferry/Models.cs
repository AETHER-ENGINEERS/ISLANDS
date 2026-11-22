using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;

namespace Islands.Ferry;

public abstract class Notifying : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;
    protected void Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return;
        field = value;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    }
}

public sealed class ChatItem : Notifying
{
    public string Id { get; init; } = "";
    private string title = "";
    public string Title { get => title; set => Set(ref title, value); }
    private string when = "";
    public string When { get => when; set => Set(ref when, value); }
}

// messages, one class per kind, so each has its own look (DataTemplates by type in MainWindow.xaml)
public abstract class Msg : Notifying { public int N { get; init; } public string At { get; init; } = ""; public string By { get; init; } = ""; }
public sealed class PersonMsg : Msg { public string Text { get; init; } = ""; }
public sealed class HerMsg : Msg { public string Text { get; init; } = ""; public string? Reasoning { get; init; } public string Model { get; init; } = ""; public bool HasReasoning => !string.IsNullOrWhiteSpace(Reasoning); public bool HasText => !string.IsNullOrWhiteSpace(Text); }
public sealed class ToolMsg : Msg { public string Tool { get; init; } = ""; public string Text { get; init; } = ""; public bool Failed { get; init; } public string Line => (Failed ? "✗ " : "✓ ") + Tool + "  " + FirstLine(Text); private static string FirstLine(string s) { var l = s.Split('\n')[0]; return l.Length > 120 ? l[..120] + "…" : l; } }
public sealed class NoteMsg : Msg { public string Text { get; init; } = ""; }
/// <summary>Her words as they stream in; replaced by the kept message when it lands.</summary>
public sealed class LiveMsg : Msg
{
    private string text = "";
    public string Text { get => text; set => Set(ref text, value); }
    private string reasoning = "";
    public string Reasoning { get => reasoning; set { Set(ref reasoning, value); OnPropertyChanged(); } }
    public bool HasReasoning => !string.IsNullOrEmpty(reasoning);
    private string status = "thinking…";
    public string Status { get => status; set => Set(ref status, value); }
    private void OnPropertyChanged() => Set(ref hasR, HasReasoning, nameof(HasReasoning));
    private bool hasR;
}

public sealed class ThreadItem : Notifying
{
    public string Id { get; init; } = "";
    private string title = "";
    public string Title { get => title; set => Set(ref title, value); }
    private string status = "";
    public string Status { get => status; set { Set(ref status, value); Set(ref running, value == "running", nameof(Running)); } }
    private bool running;
    public bool Running => running;
    private string progress = "";
    public string Progress { get => progress; set => Set(ref progress, value); }
    public string? Chat { get; init; }
}

public sealed class VaultNode : Notifying
{
    public string Path { get; init; } = "";
    public string Name { get; init; } = "";
    public bool Dir { get; init; }
    public ObservableCollection<VaultNode> Children { get; } = new();
    public string Icon => Dir ? "▸" : "·";
}

/// <summary>Markdown, shown with the system's own text rendering (Markdig.Wpf into a read-only rich text box).</summary>
public sealed class MarkdownBox : RichTextBox
{
    public static readonly DependencyProperty MarkdownProperty = DependencyProperty.Register(nameof(Markdown), typeof(string), typeof(MarkdownBox), new PropertyMetadata("", (d, e) => ((MarkdownBox)d).Render((string)e.NewValue)));
    private static readonly Markdig.MarkdownPipeline Pipeline = Markdig.Wpf.MarkdownExtensions.UseSupportedExtensions(new Markdig.MarkdownPipelineBuilder()).Build();
    public string Markdown { get => (string)GetValue(MarkdownProperty); set => SetValue(MarkdownProperty, value); }

    public MarkdownBox()
    {
        IsReadOnly = true; IsDocumentEnabled = true; BorderThickness = new Thickness(0); Background = System.Windows.Media.Brushes.Transparent;
        Padding = new Thickness(0); IsTabStop = false;
        AddHandler(Hyperlink.RequestNavigateEvent, new System.Windows.Navigation.RequestNavigateEventHandler((_, e) =>
        {
            if (e.Uri.IsAbsoluteUri && (e.Uri.Scheme == "http" || e.Uri.Scheme == "https")) System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(e.Uri.ToString()) { UseShellExecute = true });
            e.Handled = true;
        }));
    }

    private void Render(string md)
    {
        FlowDocument doc;
        try { doc = Markdig.Wpf.Markdown.ToFlowDocument(md ?? "", Pipeline); }
        catch { doc = new FlowDocument(new Paragraph(new Run(md ?? ""))); }
        doc.PagePadding = new Thickness(0);
        doc.FontFamily = FontFamily; doc.FontSize = FontSize;
        doc.Foreground = Application.Current?.TryFindResource("Ink") as System.Windows.Media.Brush ?? Foreground;   // her words in the window's ink, whatever order the bindings land in
        Document = doc;
    }
}

/// <summary>One of her schedules as the Schedules tab lists it.</summary>
public sealed class ScheduleItem : Notifying
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public string When { get; init; } = "";
    public string? Prompt { get; init; }
    public string? Command { get; init; }
    public string? Model { get; init; }
    public string? Chat { get; init; }
    public bool Enabled { get; init; }
    public string? LastRun { get; init; }
    public string? LastStatus { get; init; }
    public string? Next { get; init; }
    public string? Running { get; init; }
    public bool IsHeartbeat => Id == "heartbeat";
    public string Icon => IsHeartbeat ? "♥" : Command != null ? "$" : "✎";
    public string Line { get; init; } = "";
    public string Sub { get; init; } = "";
}

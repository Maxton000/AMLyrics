/*
 * SmtcBridge - Windows SMTC (GSMTC) <-> JSON lines bridge.
 * Used by AMLyrics Electron main process to read now-playing info
 * (title / artist / album / cover / timeline / playback state) and to
 * send transport commands (play / pause / next / previous / seek).
 *
 * stdout: one JSON object per line (snapshot / error)
 * stdin : one JSON command per line ({"cmd":"snapshot"|"play"|"pause"|"toggle"|"next"|"previous"|"seek","positionMs":...})
 * Logs go to stderr only, so stdout stays machine-readable.
 */
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Windows.Media.Control;

internal static class Program
{
    private static GlobalSystemMediaTransportControlsSessionManager? manager;
    private static readonly object OutLock = new object();
    private static CancellationTokenSource? pollCts;

    // 本地进度插值状态：Windows 上不少播放器（尤其网易云桌面端）的 SMTC Timeline
    // 只上报播放状态，Position 长期停滞在 0。这里以系统上报的位置为锚点，
    // playing 时按真实时间推进；一旦系统给出新位置（拖动/切歌/恢复上报），立即重新锚定。
    private static string anchorKey = "";
    private static string anchorState = "";
    private static double anchorPositionMs = 0;
    private static long anchorSyncAtMs = 0;
    private static double lastRawPositionMs = -1;

    private static double ResolvePosition(string key, string state, double rawPositionMs)
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        bool statusChanged = key != anchorKey || state != anchorState || anchorSyncAtMs == 0;
        bool rawChanged = Math.Abs(rawPositionMs - lastRawPositionMs) > 50;
        lastRawPositionMs = rawPositionMs;

        if (statusChanged || rawChanged)
        {
            anchorKey = key;
            anchorState = state;
            anchorPositionMs = rawPositionMs;
            anchorSyncAtMs = now;
            return rawPositionMs;
        }
        if (string.Equals(state, "Playing", StringComparison.OrdinalIgnoreCase))
        {
            return anchorPositionMs + (now - anchorSyncAtMs);
        }
        return anchorPositionMs;
    }

    private static void Log(string message)
    {
        lock (OutLock)
        {
            Console.Error.WriteLine("[SMTC] " + message);
            Console.Error.Flush();
        }
    }

    private static void Emit(object value)
    {
        lock (OutLock)
        {
            Console.Out.WriteLine(JsonSerializer.Serialize(value));
            Console.Out.Flush();
        }
    }

    private static async Task Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.InputEncoding = new UTF8Encoding(false);

        try
        {
            manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        }
        catch (Exception ex)
        {
            Log("RequestAsync failed: " + ex.Message);
            Emit(new { type = "error", message = "SMTC manager unavailable: " + ex.Message });
            return;
        }

        manager.SessionsChanged += (s, e) => _ = PushSnapshotSafe();
        manager.CurrentSessionChanged += (s, e) => _ = PushSnapshotSafe();

        pollCts = new CancellationTokenSource();
        _ = Task.Run(() => PollLoop(pollCts.Token));

        Log("bridge ready");
        Emit(new { type = "ready" });

        string? line;
        while ((line = Console.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                HandleCommand(line);
            }
            catch (Exception ex)
            {
                Log("command error: " + ex.Message);
            }
        }

        pollCts.Cancel();
        Log("bridge exiting");
    }

    private static async Task PollLoop(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                await PushSnapshot();
            }
            catch (Exception ex)
            {
                Log("poll error: " + ex.Message);
            }
            try
            {
                await Task.Delay(500, token);
            }
            catch (TaskCanceledException)
            {
                break;
            }
        }
    }

    private static async Task PushSnapshotSafe()
    {
        try
        {
            await PushSnapshot();
        }
        catch (Exception ex)
        {
            Log("snapshot error: " + ex.Message);
        }
    }

    private static bool IsNetEase(string? appId)
    {
        if (string.IsNullOrWhiteSpace(appId)) return false;
        string s = appId.ToLowerInvariant();
        return s.Contains("cloudmusic") || s.Contains("netease") || s.Contains("网易云");
    }

    private static string SafeStatus(GlobalSystemMediaTransportControlsSession? session)
    {
        if (session == null) return "idle";
        try
        {
            var info = session.GetPlaybackInfo();
            return info == null ? "idle" : info.PlaybackStatus.ToString();
        }
        catch
        {
            return "idle";
        }
    }

    private static bool IsPlaying(GlobalSystemMediaTransportControlsSession? session)
    {
        return SafeStatus(session).Equals("Playing", StringComparison.OrdinalIgnoreCase);
    }

    private static GlobalSystemMediaTransportControlsSession? SelectSession()
    {
        if (manager == null) return null;
        IReadOnlyList<GlobalSystemMediaTransportControlsSession> sessions;
        try
        {
            sessions = manager.GetSessions();
        }
        catch
        {
            return null;
        }
        if (sessions.Count == 0) return null;

        // Prefer NetEase Cloud Music (the user's target player), especially when playing.
        var preferred = sessions
            .Where(s => IsNetEase(s.SourceAppUserModelId))
            .OrderByDescending(s => IsPlaying(s) ? 1 : 0)
            .FirstOrDefault();
        if (preferred != null) return preferred;

        var current = manager.GetCurrentSession();
        if (current != null && IsPlaying(current)) return current;
        var playing = sessions.FirstOrDefault(IsPlaying);
        if (playing != null) return playing;
        return current ?? sessions[0];
    }

    private static async Task<object?> BuildSessionInfo(GlobalSystemMediaTransportControlsSession session,
        bool interpolate = false)
    {
        try
        {
            string appId = session.SourceAppUserModelId ?? "";
            string title = "";
            string artist = "";
            string album = "";
            try
            {
                // 系统接口只取播放信息（歌名/歌手/专辑），封面改由 Node 侧联网匹配
                var props = await session.TryGetMediaPropertiesAsync();
                if (props != null)
                {
                    title = props.Title ?? "";
                    artist = props.Artist ?? "";
                    album = props.AlbumTitle ?? "";
                }
            }
            catch (Exception ex)
            {
                Log("media properties error: " + ex.Message);
            }

            double positionMs = 0;
            double durationMs = 0;
            bool canPlay = false, canPause = false, canNext = false, canPrevious = false, canSeek = false;
            string status = "idle";
            try
            {
                var timeline = session.GetTimelineProperties();
                if (timeline != null)
                {
                    var start = timeline.StartTime;
                    positionMs = Math.Max(0, (timeline.Position - start).TotalMilliseconds);
                    durationMs = Math.Max(0, (timeline.EndTime - start).TotalMilliseconds);
                }
            }
            catch { }
            try
            {
                var playback = session.GetPlaybackInfo();
                if (playback != null)
                {
                    status = playback.PlaybackStatus.ToString();
                    var c = playback.Controls;
                    if (c != null)
                    {
                        canPlay = c.IsPlayEnabled;
                        canPause = c.IsPauseEnabled;
                        canNext = c.IsNextEnabled;
                        canPrevious = c.IsPreviousEnabled;
                        canSeek = c.IsPlaybackPositionEnabled;
                    }
                }
            }
            catch { }

            // 仅对「当前选中会话」做本地进度插值，避免列表里其它会话污染锚点
            if (interpolate)
            {
                string key = appId + "|" + title + "|" + artist;
                positionMs = ResolvePosition(key, status, positionMs);
            }

            return new
            {
                id = appId,
                sourceAppId = appId,
                title,
                artist,
                album,
                playbackStatus = status,
                positionMs,
                durationMs,
                syncAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                controls = new { canPlay, canPause, canNext, canPrevious, canSeek }
            };
        }
        catch (Exception ex)
        {
            Log("session info error: " + ex.Message);
            return null;
        }
    }

    private static async Task PushSnapshot()
    {
        if (manager == null) return;
        var all = new List<object>();
        try
        {
            foreach (var session in manager.GetSessions())
            {
                var info = await BuildSessionInfo(session);
                if (info != null) all.Add(info);
            }
        }
        catch (Exception ex)
        {
            Log("enumerate error: " + ex.Message);
        }

        object? current = null;
        var selected = SelectSession();
        if (selected != null)
        {
            // 单独重建当前会话以套用进度插值（列表里的对象不插值）
            current = await BuildSessionInfo(selected, interpolate: true);
        }

        Emit(new
        {
            type = "snapshot",
            ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            current,
            sessions = all
        });
    }

    private static void HandleCommand(string line)
    {
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        string cmd = root.TryGetProperty("cmd", out var cmdProp) ? cmdProp.GetString() ?? "" : "";

        if (cmd == "snapshot")
        {
            _ = PushSnapshotSafe();
            return;
        }

        GlobalSystemMediaTransportControlsSession? session = SelectSession();
        if (session == null)
        {
            Log("no session for command " + cmd);
            return;
        }

        switch (cmd)
        {
            case "play":
                _ = session.TryPlayAsync();
                break;
            case "pause":
                _ = session.TryPauseAsync();
                break;
            case "toggle":
                if (IsPlaying(session)) _ = session.TryPauseAsync();
                else _ = session.TryPlayAsync();
                break;
            case "next":
                _ = session.TrySkipNextAsync();
                break;
            case "previous":
                _ = session.TrySkipPreviousAsync();
                break;
            case "seek":
                if (root.TryGetProperty("positionMs", out var posProp))
                {
                    double ms = posProp.GetDouble();
                    _ = session.TryChangePlaybackPositionAsync((long)Math.Max(0, ms * 10000));
                }
                break;
            default:
                Log("unknown command " + cmd);
                return;
        }
        _ = PushSnapshotSafe();
    }
}

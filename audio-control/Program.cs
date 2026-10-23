using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using Windows.Media.Control;
using Windows.Storage.Streams;

if (args.Length == 0)
{
    Console.Error.WriteLine("Usage: controller | mute | unmute | toggle | status | media-toggle | media-pause | media-next | media-previous | media-art | media-info | media-stream | play <filepath> | mic-pass");
    return 2;
}

Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.High;

switch (args[0].ToLowerInvariant())
{
    case "controller":
        try
        {
            await RunControllerAsync();
            break;
        }
        catch (Exception ex)
        {
            LogControllerError("Controller stopped because of an unhandled exception.", ex);
            return 1;
        }
    case "status":
        ReportMicrophoneStatus();
        break;
    case "mute":
        SetMicrophoneMute(true);
        Console.WriteLine("muted");
        break;
    case "unmute":
        SetMicrophoneMute(false);
        Console.WriteLine("unmuted");
        break;
    case "toggle":
        using (var enumerator = new MMDeviceEnumerator())
        using (var device = GetPhysicalMicrophone(enumerator))
        {
            device.AudioEndpointVolume.Mute = !device.AudioEndpointVolume.Mute;
            Console.WriteLine(device.AudioEndpointVolume.Mute ? "muted" : "unmuted");
        }
        break;
    case "media-toggle":
    case "media-pause":
        PressMediaKey(0xB3);
        break;
    case "media-next":
        PressMediaKey(0xB0);
        break;
    case "media-previous":
        PressMediaKey(0xB1);
        break;
    case "media-art":
        Console.WriteLine(await GetActiveMediaThumbnailAsBase64Async());
        break;
    case "media-info":
        Console.WriteLine(await GetActiveMediaInfoAsync());
        break;
    case "media-stream":
        await StreamMediaInfoAsync(CancellationToken.None, false);
        break;
    case "play":
        if (args.Length < 2)
        {
            Console.Error.WriteLine("play requires a file path");
            return 2;
        }
        var volume = args.Length >= 3 && float.TryParse(args[2], System.Globalization.CultureInfo.InvariantCulture, out var requestedVolume)
            ? Math.Clamp(requestedVolume, 0f, 1f)
            : 1f;
        PlaySoundToVBCable(args[1], volume);
        break;
    case "mic-pass":
        PassMicrophoneToVBCable(CancellationToken.None);
        break;
    default:
        Console.Error.WriteLine($"Unsupported command: {args[0]}");
        return 2;
}

return 0;

static async Task RunControllerAsync()
{
    Console.SetOut(new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true });
    using var shutdown = new CancellationTokenSource();
    using var mediaCancellation = CancellationTokenSource.CreateLinkedTokenSource(shutdown.Token);
    var writeLock = new object();
    var mediaTask = StreamMediaInfoAsync(mediaCancellation.Token, true, writeLock);
    var state = new ControllerState();

    try
    {
        using var input = new StreamReader(Console.OpenStandardInput());
        while (await input.ReadLineAsync() is { } line)
        {
            try
            {
                using var request = JsonDocument.Parse(line);
                var root = request.RootElement;
                var id = root.GetProperty("id").GetInt32();
                var command = root.GetProperty("command").GetString() ?? string.Empty;
                var result = await ExecuteControllerCommandAsync(command, root, state);
                WriteControllerMessage(new { id, ok = true, result }, writeLock);
            }
            catch (Exception ex)
            {
                WriteControllerMessage(new
                {
                    id = TryGetRequestId(line),
                    ok = false,
                    error = ex.Message
                }, writeLock);
            }
        }
    }
    finally
    {
        shutdown.Cancel();
        mediaCancellation.Cancel();
        state.MicrophoneCancellation?.Cancel();
        if (state.MicrophoneTask is not null)
        {
            await state.MicrophoneTask;
        }
        await mediaTask;
    }
}

static async Task<string> ExecuteControllerCommandAsync(
    string command,
    JsonElement request,
    ControllerState state)
{
    switch (command)
    {
        case "status":
            using (var enumerator = new MMDeviceEnumerator())
            using (var device = GetPhysicalMicrophone(enumerator))
            {
                return device.AudioEndpointVolume.Mute ? "muted" : "unmuted";
            }
        case "mute":
            SetMicrophoneMute(true);
            return "muted";
        case "unmute":
            SetMicrophoneMute(false);
            return "unmuted";
        case "toggle":
            using (var enumerator = new MMDeviceEnumerator())
            using (var device = GetPhysicalMicrophone(enumerator))
            {
                device.AudioEndpointVolume.Mute = !device.AudioEndpointVolume.Mute;
                return device.AudioEndpointVolume.Mute ? "muted" : "unmuted";
            }
        case "media-toggle":
        case "media-pause":
            PressMediaKey(0xB3);
            return string.Empty;
        case "media-next":
            PressMediaKey(0xB0);
            return string.Empty;
        case "media-previous":
            PressMediaKey(0xB1);
            return string.Empty;
        case "play":
            PlaySoundToVBCable(
                request.GetProperty("arg").GetString() ?? string.Empty,
                request.TryGetProperty("extraArg", out var extraArg)
                    ? extraArg.GetSingle()
                    : 1f);
            return "played";
        case "passthrough-status":
            return state.MicrophoneTask is { IsCompleted: false } ? "active" : "stopped";
        case "passthrough-start":
            if (state.MicrophoneTask is { IsCompleted: false })
            {
                return "active";
            }

            state.MicrophoneCancellation?.Dispose();
            state.MicrophoneCancellation = new CancellationTokenSource();
            var cancellationToken = state.MicrophoneCancellation.Token;
            state.MicrophoneTask = Task.Run(() => PassMicrophoneToVBCable(cancellationToken), cancellationToken);
            await Task.Delay(50);
            return "starting";
        case "passthrough-stop":
            state.MicrophoneCancellation?.Cancel();
            if (state.MicrophoneTask is not null)
            {
                await state.MicrophoneTask;
            }
            state.MicrophoneCancellation?.Dispose();
            state.MicrophoneCancellation = null;
            state.MicrophoneTask = null;
            return "stopped";
        default:
            throw new InvalidOperationException($"Unsupported controller command: {command}");
    }
}

static int TryGetRequestId(string line)
{
    try
    {
        using var document = JsonDocument.Parse(line);
        return document.RootElement.TryGetProperty("id", out var id) ? id.GetInt32() : 0;
    }
    catch (JsonException)
    {
        return 0;
    }
}

static void WriteControllerMessage(object message, object writeLock)
{
    lock (writeLock)
    {
        Console.WriteLine(JsonSerializer.Serialize(message));
    }
}

static void SetMicrophoneMute(bool muted)
{
    using var enumerator = new MMDeviceEnumerator();
    using var device = GetPhysicalMicrophone(enumerator);
    device.AudioEndpointVolume.Mute = muted;
}

static void ReportMicrophoneStatus()
{
    using var enumerator = new MMDeviceEnumerator();
    using var device = GetPhysicalMicrophone(enumerator);
    Console.WriteLine(device.AudioEndpointVolume.Mute ? "muted" : "unmuted");
}

[DllImport("user32.dll", SetLastError = true)]
static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

static void PressMediaKey(byte virtualKey)
{
    const uint keyUp = 0x0002;
    keybd_event(virtualKey, 0, 0, UIntPtr.Zero);
    keybd_event(virtualKey, 0, keyUp, UIntPtr.Zero);
}

static void PlaySoundToVBCable(string filePath, float volume)
{
    if (!File.Exists(filePath))
    {
        throw new FileNotFoundException("File not found.", filePath);
    }

    using var enumerator = new MMDeviceEnumerator();
    using var cable = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
        .FirstOrDefault(device => device.FriendlyName.Contains("CABLE Input", StringComparison.OrdinalIgnoreCase));
    if (cable is null)
    {
        throw new InvalidOperationException("VB-CABLE playback endpoint not found.");
    }

    using var reader = new AudioFileReader(filePath) { Volume = volume };
    using var player = new WasapiOut(cable, AudioClientShareMode.Shared, true, 20);
    using var playbackStopped = new ManualResetEventSlim(false);
    player.PlaybackStopped += (_, _) => playbackStopped.Set();
    player.Init(reader);
    player.Play();
    playbackStopped.Wait();
}

static void PassMicrophoneToVBCable(CancellationToken cancellationToken)
{
    using var enumerator = new MMDeviceEnumerator();
    using var cable = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
        .FirstOrDefault(device => device.FriendlyName.Contains("CABLE Input", StringComparison.OrdinalIgnoreCase));
    if (cable is null)
    {
        throw new InvalidOperationException("VB-CABLE playback endpoint not found.");
    }

    using var microphoneDevice = GetPhysicalMicrophone(enumerator);
    using var microphone = new WasapiCapture(microphoneDevice, true, 20);
    var buffer = new BufferedWaveProvider(microphone.WaveFormat)
    {
        DiscardOnBufferOverflow = true,
        BufferDuration = TimeSpan.FromMilliseconds(200)
    };
    using var output = new WasapiOut(cable, AudioClientShareMode.Shared, true, 20);

    microphone.DataAvailable += (_, eventArgs) => buffer.AddSamples(eventArgs.Buffer, 0, eventArgs.BytesRecorded);
    output.Init(buffer);
    output.Play();
    microphone.StartRecording();

    Console.Error.WriteLine($"Microphone passthrough active: {microphoneDevice.FriendlyName} -> {cable.FriendlyName}");
    using var exitSignal = new ManualResetEventSlim(false);
    using var registration = cancellationToken.Register(() => exitSignal.Set());
    exitSignal.Wait();
    microphone.StopRecording();
    output.Stop();
}

static bool IsVirtualCable(string deviceName)
{
    return deviceName.Contains("CABLE Output", StringComparison.OrdinalIgnoreCase)
        || deviceName.Contains("VB-Audio", StringComparison.OrdinalIgnoreCase);
}

static MMDevice GetPhysicalMicrophone(MMDeviceEnumerator enumerator)
{
    var defaultMicrophone = enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Multimedia);
    if (!IsVirtualCable(defaultMicrophone.FriendlyName))
    {
        return defaultMicrophone;
    }

    var physicalMicrophone = enumerator.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active)
        .FirstOrDefault(device => !IsVirtualCable(device.FriendlyName));
    defaultMicrophone.Dispose();

    return physicalMicrophone ?? throw new InvalidOperationException("No physical microphone was found.");
}

static async Task<string> GetActiveMediaThumbnailAsBase64Async()
{
    try
    {
        var sessionManager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        var currentSession = sessionManager.GetCurrentSession();
        if (currentSession == null) return string.Empty;

        var mediaProperties = await currentSession.TryGetMediaPropertiesAsync();
        if (mediaProperties?.Thumbnail == null) return string.Empty;

        using var winRtStream = await mediaProperties.Thumbnail.OpenReadAsync();
        using var netStream = winRtStream.AsStreamForRead();
        using var memoryStream = new MemoryStream();
        await netStream.CopyToAsync(memoryStream);
        return Convert.ToBase64String(memoryStream.ToArray());
    }
    catch
    {
        return string.Empty;
    }
}

static async Task<string> GetActiveMediaInfoAsync()
{
    try
    {
        var sessionManager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        var currentSession = sessionManager.GetCurrentSession();
        if (currentSession == null)
        {
            return JsonSerializer.Serialize(new { albumArt = "", title = "", artist = "" });
        }

        var mediaProperties = await currentSession.TryGetMediaPropertiesAsync();
        var albumArt = "";
        if (mediaProperties?.Thumbnail != null)
        {
            using var winRtStream = await mediaProperties.Thumbnail.OpenReadAsync();
            using var netStream = winRtStream.AsStreamForRead();
            using var memoryStream = new MemoryStream();
            await netStream.CopyToAsync(memoryStream);
            albumArt = Convert.ToBase64String(memoryStream.ToArray());
        }

        return JsonSerializer.Serialize(new
        {
            albumArt,
            title = mediaProperties?.Title ?? "",
            artist = mediaProperties?.Artist ?? ""
        });
    }
    catch
    {
        return JsonSerializer.Serialize(new { albumArt = "", title = "", artist = "" });
    }
}

static async Task StreamMediaInfoAsync(CancellationToken cancellationToken, bool controllerMode, object? writeLock = null)
{
    string? previousInfo = null;
    while (!cancellationToken.IsCancellationRequested)
    {
        try
        {
            var mediaInfo = await GetActiveMediaInfoAsync();
            if (mediaInfo != previousInfo)
            {
                if (controllerMode)
                {
                    var data = JsonSerializer.Deserialize<JsonElement>(mediaInfo);
                    WriteControllerMessage(new { type = "media", data }, writeLock!);
                }
                else
                {
                    Console.WriteLine(mediaInfo);
                }
                previousInfo = mediaInfo;
            }

            await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return;
        }
        catch (Exception ex)
        {
            LogControllerError("Media monitoring iteration failed; continuing.", ex);
            await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
        }
    }
}

static void LogControllerError(string message, Exception exception)
{
    var details = $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}{exception}{Environment.NewLine}";
    try
    {
        File.AppendAllText(
            Path.Combine(AppContext.BaseDirectory, "audio-controller.log"),
            details);
    }
    catch
    {
    }

    Console.Error.WriteLine(details);
}

sealed class ControllerState
{
    public Task? MicrophoneTask { get; set; }
    public CancellationTokenSource? MicrophoneCancellation { get; set; }
}

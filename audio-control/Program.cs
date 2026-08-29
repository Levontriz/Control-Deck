using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.Wave;

if (args.Length == 0)
{
    Console.Error.WriteLine("Usage: mute | unmute | toggle | media-toggle | media-pause | media-next | media-previous | play <filepath> | mic-pass");
    return 2;
}

switch (args[0].ToLowerInvariant())
{
    case "status":
        ReportMicrophoneStatus();
        break;
    case "mute":
        SetMicrophoneMute(true);
        break;
    case "unmute":
        SetMicrophoneMute(false);
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
        PassMicrophoneToVBCable();
        break;
    default:
        Console.Error.WriteLine($"Unsupported command: {args[0]}");
        return 2;
}

return 0;

static void SetMicrophoneMute(bool muted)
{
    using var enumerator = new MMDeviceEnumerator();
    using var device = GetPhysicalMicrophone(enumerator);
    device.AudioEndpointVolume.Mute = muted;
    Console.WriteLine(muted ? "muted" : "unmuted");
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
        Console.Error.WriteLine($"File not found: {filePath}");
        Environment.Exit(1);
    }

    try
    {
        using var enumerator = new MMDeviceEnumerator();
        using var cable = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
            .FirstOrDefault(device => device.FriendlyName.Contains("CABLE Input", StringComparison.OrdinalIgnoreCase));
        if (cable is null)
        {
            Console.Error.WriteLine("VB-CABLE playback endpoint not found. Expected a device containing 'CABLE Input'.");
            Environment.Exit(1);
        }

        using var reader = new AudioFileReader(filePath);
        reader.Volume = volume;
        using var player = new WasapiOut(cable, AudioClientShareMode.Shared, true, 20);
        var playbackStopped = new ManualResetEventSlim(false);
        player.PlaybackStopped += (_, _) => playbackStopped.Set();
        player.Init(reader);
        player.Play();

        playbackStopped.Wait();
        Console.WriteLine("played");
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Playback error: {ex.Message}");
        Environment.Exit(1);
    }
}

static void PassMicrophoneToVBCable()
{
    using var enumerator = new MMDeviceEnumerator();
    using var cable = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
        .FirstOrDefault(device => device.FriendlyName.Contains("CABLE Input", StringComparison.OrdinalIgnoreCase));

    if (cable is null)
    {
        Console.Error.WriteLine("VB-CABLE playback endpoint not found. Expected a device containing 'CABLE Input'.");
        Environment.Exit(1);
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

    Console.WriteLine($"Microphone passthrough active: {microphoneDevice.FriendlyName} -> {cable.FriendlyName} ({microphone.WaveFormat})");
    var exitSignal = new ManualResetEventSlim(false);
    Console.CancelKeyPress += (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        exitSignal.Set();
    };

    try
    {
        exitSignal.Wait();
    }
    finally
    {
        microphone.StopRecording();
        output.Stop();
        exitSignal.Dispose();
    }
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

    if (physicalMicrophone is null)
    {
        throw new InvalidOperationException("No physical microphone was found.");
    }

    return physicalMicrophone;
}

# Control Deck

Customizable streaming control board for tablets, with a live OBS overlay, microphone controls, media controls, and soundboard actions.

This project runs on Windows and expects a virtual audio device called VB-Audio Virtual Cable (or a compatible VB-Audio device) so the app can mute and pass through microphone audio and route sounds to a virtual output.

## Requirements

- Windows 10 or 11
- Node.js 18+
- .NET 8 SDK
- VB-Audio Virtual Cable installed
- OBS Studio
- A tablet or phone on the same Wi‑Fi network as the PC
- Optional: a browser tab on the same PC for testing

## 1) Install the virtual audio device

This project expects a VB-Audio virtual cable to exist so it can:

- detect the physical microphone when toggling mic mute
- play uploaded sounds through a virtual output
- pass microphone audio into a virtual cable for Discord/OBS use

### Install VB-Audio Virtual Cable

1. Download VB-Audio Virtual Cable from the official VB-Audio site.
2. Run the installer as Administrator.
3. Reboot if the installer requests it.
4. Open Sound Settings on Windows.
5. Go to Sound Control Panel > Playback and Recording tabs.
6. Confirm that devices like "CABLE Input" and "CABLE Output" appear.

### Recommended Windows audio setup

For best results:

- Set your actual microphone as the default system input device.
- Keep "CABLE Input" available so the app can route mic audio to OBS/Discord.
- Use "CABLE Output" as the playback device for soundboard or passthrough testing.
- In Discord, OBS, or another app, choose "CABLE Input" as the microphone source when you want the mic to be passed through the virtual cable.

> The helper app in this repo checks for names containing "CABLE Input" and "CABLE Output" / "VB-Audio" so it can find the correct virtual devices automatically.

## 2) Install project dependencies

Open a PowerShell terminal in the project folder and run:

```powershell
npm install
cd audio-control
dotnet restore
dotnet publish -c Release -r win-x64 --self-contained false -o publish
```

This creates the helper binary used by the server at:

```text
audio-control\publish\audio-control.dll
```

If you want to publish again later, re-run the `dotnet publish` command above.

## 3) Create the HTTPS certificate for the tablet page

The server tries to start a secure tablet page on port 3443 if a certificate exists at:

```text
certs\server.pfx
```

If the file is missing, the app will warn that the HTTPS certificate is missing, but the main HTTP API on port 3000 will still work.

To generate a local self-signed certificate, run:

```powershell
New-Item -ItemType Directory -Force certs

$cert = New-SelfSignedCertificate -CertStoreLocation Cert:\CurrentUser\My `
  -FriendlyName "ControlDeckLocal" `
  -Subject "CN=localhost" `
  -KeyExportPolicy Exportable `
  -Type RSA -KeyLength 2048

Export-PfxCertificate -Cert $cert -FilePath .\certs\server.pfx `
  -Password (ConvertTo-SecureString -String "overlay-local" -AsPlainText -Force)
```

The server is configured to use the password `overlay-local`.

## 4) Run the server

From the project root:

```powershell
node server.js
```

You should see output similar to:

```text
OBS Overlay WebSocket server running on ws://localhost:8080
Deckboard API listener running on http://localhost:3000
```

If the certificate was created successfully, you will also see a message like:

```text
Tablet HTTPS page available on https://192.168.1.36:3443
```

### Verify the server is alive

Open a browser on the same machine and visit:

```text
http://localhost:3000/api/status
```

The response should be JSON showing `linked` and `muted` values.

## 5) Connect the control board using a tablet

1. Connect your tablet and the Windows PC to the same Wi‑Fi network.
2. Find the PC's local IP address:

```powershell
ipconfig
```

Look for the IPv4 address under the active Wi‑Fi or Ethernet adapter.

3. Open the browser on the tablet.
4. Visit either:

```text
http://<PC_IP>:3000
```

or, if the HTTPS certificate is trusted and the server is running with it:

```text
https://<PC_IP>:3443
```

5. Accept any certificate warning for the self-signed local cert.
6. Use the page in full-screen mode to make it behave like a proper stream deck.

The tablet page uses the JSON deck configuration in `public/config.json`, and each button sends actions to the local API endpoints such as:

- `/api/macro`
- `/api/media`
- `/api/audio`
- `/api/audio-passthrough`
- `/api/soundboard`

To show the current Windows media artwork as a spinning vinyl status tile, add `"status": "media"` to a configured button. The local Windows helper stays running in media-stream mode and sends only changed artwork, title, and artist data to the local server. The browser receives those updates over the local `/api/media/stream` event stream.

## 6) Use the OBS overlay

The overlay file is `overlay.html`. It connects to the WebSocket server on `ws://localhost:8080` and receives spawn events from the deck.

### Add the overlay in OBS

1. Open OBS Studio.
2. Add a new Browser Source.
3. Choose either:
   - Local file: select `overlay.html` from this project, or
   - URL: point to a locally served copy of the file if you prefer.
4. Set the browser source width/height to your scene resolution, such as 1920x1080.
5. Leave the source transparent and check the browser source so it shows the overlay animation.
6. Put the browser source above your game or webcam layer in the scene.

### How the overlay works

When a trigger is sent from the tablet, the server broadcasts a WebSocket message. The overlay listens for:

```json
{ "type": "SPAWN_ITEM", "username": "Doug", "colour": "#FF0000" }
```

and then creates a falling item animation that appears in the scene.

## 7) Typical workflow

1. Start the Windows PC and ensure VB-Audio is installed.
2. Start the app:

```powershell
node server.js
```

3. Open the tablet page on the same Wi‑Fi:

```text
http://<PC_IP>:3000
```

4. Open OBS and add the overlay source.
5. Trigger actions from the deck to test mic mute, media controls, soundboard audio, and item spawn events.

## 8) Troubleshooting

### The tablet cannot connect

- Make sure both devices are on the same Wi‑Fi network.
- Check the PC's IP with `ipconfig`.
- Confirm `node server.js` is still running.
- Test the API directly in a browser:

```text
http://<PC_IP>:3000/api/status
```

### The audio helper fails

- Confirm `dotnet` is installed.
- Re-run the publish command in `audio-control`.
- Check that the `publish` folder exists and contains `audio-control.dll`.
- Make sure VB-Audio is installed and its virtual devices are present.

### The overlay is blank or not receiving events

- Confirm the OBS Browser Source is loading the overlay file.
- Check that the WebSocket server is running on `ws://localhost:8080`.
- Test by opening the overlay file in a browser on the same PC.

### The HTTPS tablet page shows a warning

- This is expected with a self-signed local certificate.
- Either accept the warning or use the plain HTTP URL on port 3000.

## Notes

- The app is designed for local network use and not for public internet exposure.
- The project assumes a Windows desktop machine; the helper uses NAudio and Windows-specific audio APIs.
- The overlay and the server are intentionally separated so OBS can receive events without needing to render the tablet UI.

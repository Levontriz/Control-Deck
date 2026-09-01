// Run: npm install express ws
const express = require('express');
const { WebSocketServer } = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const public = path.join(__dirname, 'public');
const app = express();
const httpsPort = 3443;
const certificatePath = path.join(__dirname, 'certs', 'server.pfx');
const runFile = promisify(execFile);
const audioHelper = path.join(__dirname, 'audio-control', 'publish', 'audio-control.dll');
let microphonePassthrough = null;

// ---- MIDDLEWARE ----
app.use(express.json());          // Required to read JSON bodies in req.body
app.use(express.static(public));  // Serves your index.html from the public directory

// ---- 1. SETUP WEBSOCKET SERVER FOR OBS OVERLAY ----
const wss = new WebSocketServer({ port: 8080 });
console.log('OBS Overlay WebSocket server running on ws://localhost:8080');

wss.on('connection', (ws) => {
    console.log(`OBS Overlay connected successfully! Active streams: ${wss.clients.size}`);

    ws.on('close', () => {
        console.log(`OBS Overlay connection closed. Remaining streams: ${wss.clients.size}`);
    });
});

function broadcast(payload) {
    const message = JSON.stringify(payload);
    let broadcastCount = 0;

    wss.clients.forEach((client) => {
        if (client.readyState === client.OPEN) {
            client.send(message);
            broadcastCount++;
        }
    });

    return broadcastCount;
}

async function runAudioHelper(command, arg, extraArg) {
    if (!fs.existsSync(audioHelper)) {
        throw new Error(`Audio helper missing: ${audioHelper}`);
    }

    const args = [audioHelper, command];
    if (arg) args.push(arg);
    if (extraArg !== undefined) args.push(String(extraArg));
    const { stdout } = await runFile('dotnet', args, { windowsHide: true });
    return stdout.trim();
}

// ---- 2. SETUP DECKBOARD WEBHOOK ENDPOINT (HTTP) ----
app.post('/api/macro', (req, res) => {
    const { action } = req.body;
    console.log(`Deckboard webhook received action: "${action}"`);

    // Handle the specific spawn action triggered by the tablet button
    if (action === 'SPAWN_ITEM') {
        const testUsers = ['Doug', 'Chat', 'W00ster', 'Scurvy_Jones'];
        const colours = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF'];
        
        const randomUser = testUsers[Math.floor(Math.random() * testUsers.length)];
        const randomColour = colours[Math.floor(Math.random() * colours.length)];

        const payload = JSON.stringify({
            type: 'SPAWN_ITEM',
            username: randomUser,
            colour: randomColour
        });

        const broadcastCount = broadcast(JSON.parse(payload));

        if (broadcastCount > 0) {
            console.log(`Triggered spawn via Tablet for: ${randomUser} (${broadcastCount} frames active)`);
        } else {
            console.log("Deckboard pressed, but OBS Overlay is not connected.");
        }
    }

    // Always send a quick 200 OK response back to Deckboard so it doesn't timeout
    res.sendStatus(200);
});

app.post('/api/media', (req, res) => {
    const { command } = req.body;
    const supportedCommands = ['TOGGLE', 'PAUSE', 'NEXT', 'PREVIOUS'];

    if (!supportedCommands.includes(command)) {
        return res.status(400).json({ error: 'Unsupported media command.' });
    }

    const helperCommands = {
        TOGGLE: 'media-toggle',
        NEXT: 'media-next',
        PREVIOUS: 'media-previous'
    };
    const helperCommand = helperCommands[command];
    runAudioHelper(helperCommand)
        .then(() => {
            const broadcastCount = broadcast({ type: 'MEDIA_COMMAND', command });
            console.log(`Media command received: "${command}" (${broadcastCount} listeners)`);
            res.sendStatus(200);
        })
        .catch((error) => {
            console.error('Media command failed:', error.message);
            res.status(500).json({ error: 'Windows media control failed.' });
        });
});

app.post('/api/audio', async (req, res) => {
    const { target, state } = req.body;

    if (target !== 'mic' || !['mute', 'unmute', 'toggle'].includes(state)) {
        return res.status(400).json({ error: 'Unsupported audio command.' });
    }

    try {
        const actualState = await runAudioHelper(state);
        const broadcastCount = broadcast({ type: 'AUDIO_COMMAND', target, state: actualState });
        console.log(`Audio command received: ${target} ${actualState} (${broadcastCount} listeners)`);
        res.json({ target, state: actualState });
    } catch (error) {
        console.error('Audio command failed:', error.message);
        res.status(500).json({ error: 'Windows microphone control failed.' });
    }
});

app.get('/api/status', async (req, res) => {
    try {
        const microphoneState = await runAudioHelper('status');
        res.json({
            linked: Boolean(microphonePassthrough && !microphonePassthrough.killed),
            muted: microphoneState === 'muted'
        });
    } catch (error) {
        console.error('Audio status check failed:', error.message);
        res.status(500).json({ error: 'Windows audio status unavailable.' });
    }
});

app.post('/api/audio-passthrough', (req, res) => {
    const { state } = req.body;

    const requestedState = state === 'toggle'
        ? (microphonePassthrough && !microphonePassthrough.killed ? 'stop' : 'start')
        : state;

    if (!['start', 'stop'].includes(requestedState)) {
        return res.status(400).json({ error: 'State must be start, stop, or toggle.' });
    }

    if (requestedState === 'start') {
        if (microphonePassthrough && !microphonePassthrough.killed) {
            return res.json({ state: 'active' });
        }

        if (!fs.existsSync(audioHelper)) {
            return res.status(500).json({ error: `Audio helper missing: ${audioHelper}` });
        }

        microphonePassthrough = spawn('dotnet', [audioHelper, 'mic-pass'], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        microphonePassthrough.stdout.on('data', (data) => console.log(data.toString().trim()));
        microphonePassthrough.stderr.on('data', (data) => console.error(data.toString().trim()));
        microphonePassthrough.on('exit', (code) => {
            console.log(`Microphone passthrough stopped (${code ?? 'terminated'})`);
            microphonePassthrough = null;
        });

        return res.json({ state: 'starting' });
    }

    if (microphonePassthrough && !microphonePassthrough.killed) {
        microphonePassthrough.kill();
        microphonePassthrough = null;
    }
    res.json({ state: 'stopped' });
});

app.post('/api/soundboard', async (req, res) => {
    const { sound, volume = 0.35 } = req.body;

    if (!sound || typeof sound !== 'string') {
        return res.status(400).json({ error: 'Sound name required.' });
    }
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) {
        return res.status(400).json({ error: 'Volume must be a number between 0 and 1.' });
    }

    const soundPath = path.join(public, 'sounds', `${sound}.wav`);
    if (!fs.existsSync(soundPath)) {
        return res.status(404).json({ error: `Sound not found: ${sound}` });
    }

    runAudioHelper('play', soundPath, volume)
        .then(() => {
            const broadcastCount = broadcast({ type: 'SOUNDBOARD_ACTION', sound });
            console.log(`Soundboard played: ${sound} (${broadcastCount} listeners)`);
            res.sendStatus(200);
        })
        .catch((error) => {
            console.error('Soundboard playback failed:', error.message);
            res.status(500).json({ error: 'VB-CABLE playback failed.' });
        });
});

// Start the HTTP API server on port 3000
app.listen(3000, () => {
    console.log('Deckboard API listener running on http://localhost:3000');
});

if (fs.existsSync(certificatePath)) {
    https.createServer(
        {
            pfx: fs.readFileSync(certificatePath),
            passphrase: 'overlay-local'
        },
        app
    ).listen(httpsPort, () => {
        console.log(
            `Tablet HTTPS page available on https://192.168.1.36:${httpsPort}`
        );
    });
} else {
    console.warn(`HTTPS certificate missing: ${certificatePath}`);
}
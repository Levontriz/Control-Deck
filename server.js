// Run: npm install express ws
const express = require('express');
const { WebSocketServer } = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const os = require('os');

const public = path.join(__dirname, 'public');
const app = express();
const httpsPort = 3443;
const certificatePath = path.join(__dirname, 'certs', 'server.pfx');
const audioHelper = path.join(__dirname, 'audio-control', 'publish', 'audio-control.exe');
let controller = null;
let controllerReady = Promise.resolve();
let resolveControllerReady;
let rejectControllerReady;
const pendingControllerCommands = new Map();
let nextControllerRequestId = 1;
let currentMedia = { albumArt: '', title: '', artist: '' };
const mediaClients = new Set();

const highPriority = os.constants.priority.PRIORITY_HIGH;

try {
    os.setPriority(0, highPriority);
    console.log('Main Node.js process priority set to HIGH.');
} catch (error) {
    console.error('Failed to set main process priority:', error.message);
}

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

function setHighPriority(child, description, logSuccess = true) {
    try {
        os.setPriority(child.pid, highPriority);
        if (logSuccess) {
            console.log(`${description} priority set to HIGH (PID ${child.pid}).`);
        }
    } catch (error) {
        console.error(`Failed to set ${description} priority to HIGH:`, error.message);
    }
}

function startController() {
    if (!fs.existsSync(audioHelper)) {
        console.error(`Audio helper missing: ${audioHelper}`);
        return;
    }

    controllerReady = new Promise((resolve, reject) => {
        resolveControllerReady = resolve;
        rejectControllerReady = reject;
    });

    controller = spawn(audioHelper, ['controller'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
    });

    controller.once('spawn', () => {
        setHighPriority(controller, 'Audio controller');
        resolveControllerReady();
    });

    const lines = readline.createInterface({ input: controller.stdout });
    lines.on('line', (line) => {
        try {
            const message = JSON.parse(line);
            if (message.type === 'media') {
                currentMedia = message.data;
                const payload = `data: ${JSON.stringify(currentMedia)}\n\n`;
                mediaClients.forEach((client) => client.write(payload));
                return;
            }

            const pending = pendingControllerCommands.get(message.id);
            if (!pending) return;
            pendingControllerCommands.delete(message.id);
            if (message.ok) pending.resolve(message.result ?? '');
            else pending.reject(new Error(message.error || 'Audio controller command failed.'));
        } catch (error) {
            console.error('Invalid audio controller response:', error.message);
        }
    });

    controller.stderr.on('data', (data) => {
        console.error(`Audio controller: ${data.toString().trim()}`);
    });

    controller.on('error', (error) => {
        rejectControllerReady(error);
        console.error('Audio controller failed to start:', error.message);
    });

    controller.on('exit', (code, signal) => {
        controller = null;
        pendingControllerCommands.forEach(({ reject }) => {
            reject(new Error(`Audio controller stopped (${code ?? signal ?? 'terminated'}).`));
        });
        pendingControllerCommands.clear();
        console.error(
            `Audio controller stopped (code ${code ?? 'none'}, signal ${signal ?? 'none'}); retrying in 2 seconds.`
        );
        setTimeout(startController, 2000);
    });
}

async function runAudioHelper(command, arg, extraArg) {
    await controllerReady;
    if (!controller || controller.exitCode !== null) {
        throw new Error('Audio controller is not running.');
    }

    const id = nextControllerRequestId++;
    const request = { id, command };
    if (arg !== undefined) request.arg = arg;
    if (extraArg !== undefined) request.extraArg = extraArg;

    return new Promise((resolve, reject) => {
        pendingControllerCommands.set(id, { resolve, reject });
        controller.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
            if (!error) return;
            pendingControllerCommands.delete(id);
            reject(error);
        });
    });
}

function startMediaMonitor() {
    startController();
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

// Get the current media album art and title from the Windows media player
app.get('/api/media', async (req, res) => {
    try {
        res.json(currentMedia);
    } catch (error) {
        console.error('Media status check failed:', error.message);
        res.status(500).json({ error: 'Windows media status unavailable.' });
    }
});

app.get('/api/media/stream', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(currentMedia)}\n\n`);
    mediaClients.add(res);

    req.on('close', () => mediaClients.delete(res));
});

app.post('/api/media', (req, res) => {
    const { command } = req.body;
    const supportedCommands = ['TOGGLE', 'PAUSE', 'NEXT', 'PREVIOUS'];

    if (!supportedCommands.includes(command)) {
        return res.status(400).json({ error: 'Unsupported media command.' });
    }

    const helperCommands = {
        TOGGLE: 'media-toggle',
        PAUSE: 'media-pause',
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
            const details = error.stderr?.trim() || error.message;
            console.error('Media command failed:', details);
            res.status(500).json({ error: `Windows media control failed: ${details}` });
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
            linked: await runAudioHelper('passthrough-status') === 'active',
            muted: microphoneState === 'muted'
        });
    } catch (error) {
        console.error('Audio status check failed:', error.message);
        res.status(500).json({ error: 'Windows audio status unavailable.' });
    }
});

app.post('/api/audio-passthrough', async (req, res) => {
    const { state } = req.body;

    let requestedState = state;
    if (state === 'toggle') {
        requestedState = await runAudioHelper('passthrough-status') === 'active'
            ? 'stop'
            : 'start';
    }

    if (!['start', 'stop'].includes(requestedState)) {
        return res.status(400).json({ error: 'State must be start, stop, or toggle.' });
    }

    if (requestedState === 'start') {
        const result = await runAudioHelper('passthrough-start');
        return res.json({ state: result || 'starting' });
    }

    runAudioHelper('passthrough-stop')
        .then(() => res.json({ state: 'stopped' }))
        .catch((error) => res.status(500).json({ error: error.message }));
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
    startMediaMonitor();
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
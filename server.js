// Run: npm install express ws
const express = require('express');
const { WebSocketServer } = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const os = require('os');
const crypto = require('crypto');

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
const controllerCommandTimeoutMs = 10000;
let controllerRestartTimer = null;
const highPriority = os.constants.priority.PRIORITY_HIGH;
const spotifyScopes = [
    'playlist-read-private',
    'playlist-read-collaborative',
    'user-read-playback-state',
    'user-modify-playback-state'
].join(' ');
let spotifyTokens = null;
let spotifyOAuthState = null;
let spotifyOAuthRedirectUri = null;

// ---- MIDDLEWARE ----
app.use(express.json());          // Required to read JSON bodies in req.body
app.use(express.static(public));  // Serves your index.html from the public directory

function spotifyConfigured() {
    return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

function spotifyRedirectUri(request) {
    if (process.env.SPOTIFY_REDIRECT_URI) {
        return process.env.SPOTIFY_REDIRECT_URI;
    }

    if (!request) {
        throw new Error('SPOTIFY_REDIRECT_URI is required when refreshing Spotify tokens.');
    }

    return `${request.protocol}://${request.get('host')}/api/spotify/callback`;
}

function spotifyRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const request = https.request(url, options, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                let data;
                try {
                    data = body.trim() ? JSON.parse(body) : {};
                } catch {
                    if (response.statusCode >= 200 && response.statusCode < 300) {
                        resolve({});
                        return;
                    }
                    reject(new Error(`Spotify returned invalid JSON (${response.statusCode}).`));
                    return;
                }

                if (response.statusCode < 200 || response.statusCode >= 300) {
                    const error = new Error(
                        data.error?.message
                        || data.error_description
                        || `Spotify request failed (${response.statusCode}).`
                    );
                    error.statusCode = response.statusCode;
                    error.spotifyError = data.error;
                    reject(error);
                    return;
                }
                resolve(data);
            });
        });
        request.on('error', reject);
        request.end(options.body);
    });
}

async function exchangeSpotifyToken(params) {
    const body = new URLSearchParams(params).toString();
    return spotifyRequest('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            Authorization: `Basic ${Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body)
        },
        body
    });
}

async function getSpotifyAccessToken() {
    if (!spotifyTokens) {
        throw new Error('Spotify is not connected.');
    }

    if (spotifyTokens.expiresAt > Date.now() + 60000) {
        return spotifyTokens.accessToken;
    }

    const refreshed = await exchangeSpotifyToken({
        grant_type: 'refresh_token',
        refresh_token: spotifyTokens.refreshToken
    });
    spotifyTokens = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token || spotifyTokens.refreshToken,
        expiresAt: Date.now() + (refreshed.expires_in * 1000)
    };
    return spotifyTokens.accessToken;
}

async function spotifyApi(pathname, options = {}) {
    const accessToken = await getSpotifyAccessToken();
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    return spotifyRequest(`https://api.spotify.com/v1${pathname}`, {
        method: options.method || 'GET',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
        },
        body
    });
}

app.get('/api/spotify/status', (req, res) => {
    res.json({
        configured: spotifyConfigured(),
        connected: Boolean(spotifyTokens)
    });
});

app.get('/api/spotify/login', (req, res) => {
    if (!spotifyConfigured()) {
        res.status(503).send('Spotify is not configured on this Control Deck server.');
        return;
    }

    spotifyOAuthState = crypto.randomBytes(24).toString('hex');
    spotifyOAuthRedirectUri = spotifyRedirectUri(req);
    const query = new URLSearchParams({
        response_type: 'code',
        client_id: process.env.SPOTIFY_CLIENT_ID,
        scope: spotifyScopes,
        redirect_uri: spotifyOAuthRedirectUri,
        state: spotifyOAuthState
    });
    res.redirect(`https://accounts.spotify.com/authorize?${query}`);
});

app.get('/api/spotify/callback', async (req, res) => {
    if (!req.query.code || req.query.state !== spotifyOAuthState) {
        res.status(400).send('Spotify authorization failed: invalid or expired state.');
        return;
    }

    spotifyOAuthState = null;
    try {
        const token = await exchangeSpotifyToken({
            grant_type: 'authorization_code',
            code: req.query.code,
            redirect_uri: spotifyOAuthRedirectUri
        });
        spotifyOAuthRedirectUri = null;
        spotifyTokens = {
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            expiresAt: Date.now() + (token.expires_in * 1000)
        };
        res.redirect('controldeck://spotify-connected');
    } catch (error) {
        console.error('Spotify authorization failed:', error.message);
        res.status(502).send('Spotify authorization failed. Check the server log for details.');
    }
});

app.get('/api/spotify/playlists', async (req, res) => {
    try {
        const playlists = [];
        let url = '/me/playlists?limit=50';
        while (url) {
            const page = await spotifyApi(url);
            playlists.push(...page.items.filter((playlist) => playlist && playlist.id));
            url = page.next ? new URL(page.next).pathname + new URL(page.next).search : null;
        }
        res.json(playlists.map((playlist) => ({
            id: playlist.id,
            name: playlist.name,
            image: playlist.images?.[0]?.url || '',
            trackCount: playlist.items?.total || playlist.tracks?.total || 0
        })));
    } catch (error) {
        console.error('Spotify playlist request failed:', error.message);
        res.status(502).json({ error: error.message });
    }
});

app.get('/api/spotify/playlists/:playlistId/tracks', async (req, res) => {
    try {
        const tracks = [];
        let url = `/playlists/${encodeURIComponent(req.params.playlistId)}/items?limit=100`;
        let embeddedItems = false;
        while (url) {
            let page;
            if (embeddedItems) {
                break;
            }

            try {
                page = await spotifyApi(url);
            } catch (error) {
                if (error.statusCode !== 410) {
                    throw error;
                }

                console.warn(
                    `Spotify returned 410 for /items on playlist ${req.params.playlistId}; trying embedded playlist tracks.`
                );
                const embeddedTracks = [];
                let embeddedUrl = `/playlists/${encodeURIComponent(req.params.playlistId)}?fields=${encodeURIComponent('items.items(track(id,type,name,uri,artists(name))),items.next,items.total')}`;
                let embeddedTotal = null;
                let embeddedNextPage = false;
                while (embeddedUrl) {
                    let playlist;
                    try {
                        playlist = await spotifyApi(embeddedUrl);
                    } catch (error) {
                        if (embeddedTracks.length > 0 && error.statusCode === 410) {
                            console.warn(
                                `Spotify rejected the next page for playlist ${req.params.playlistId}; returning ${embeddedTracks.length} tracks.`
                            );
                            break;
                        }
                        throw error;
                    }
                    const embeddedPage = playlist.items || playlist.tracks;
                    if (!embeddedPage || !Array.isArray(embeddedPage.items)) {
                        throw new Error('Spotify returned no track items for this playlist.');
                    }

                    embeddedTracks.push(...embeddedPage.items);
                    embeddedTotal = Number.isInteger(embeddedPage.total)
                        ? embeddedPage.total
                        : embeddedTotal;
                    embeddedNextPage = Boolean(embeddedPage.next);
                    embeddedUrl = embeddedPage.next
                        ? new URL(embeddedPage.next).pathname + new URL(embeddedPage.next).search
                        : null;
                }
                console.log(
                    `Spotify embedded playlist response ${req.params.playlistId}: `
                    + `${embeddedTracks.length}/${embeddedTotal ?? 'unknown'} tracks, `
                    + `next page: ${embeddedNextPage ? 'yes' : 'no'}.`
                );

                page = { items: embeddedTracks };
                embeddedItems = true;
            }
            tracks.push(...page.items);
            url = embeddedItems
                ? null
                : page.next
                    ? new URL(page.next).pathname + new URL(page.next).search
                    : null;
        }
        const playableTracks = tracks
            .map((entry, position) => ({
                track: entry.track || entry.item,
                position
            }))
            .filter(({ track }) => track?.uri && track?.name)
            .map(({ track, position }) => ({
                id: track.id,
                name: track.name,
                artist: (track.artists || []).map((artist) => artist.name).join(', '),
                uri: track.uri,
                position
            }));
        console.log(
            `Spotify playlist ${req.params.playlistId}: ${playableTracks.length} playable tracks.`
        );
        res.json(playableTracks);
    } catch (error) {
        console.error(
            `Spotify track request failed for playlist ${req.params.playlistId}:`,
            error.statusCode || 'unknown',
            error.message
        );
        res.status(error.statusCode === 410 ? 410 : 502).json({
            error: error.statusCode === 410
                ? 'Spotify reports that this playlist is no longer available through the Web API.'
                : error.message,
            statusCode: error.statusCode || null
        });
    }
});

app.put('/api/spotify/play', async (req, res) => {
    const { playlistId, trackUri, position } = req.body;
    if (!playlistId && !trackUri) {
        res.status(400).json({ error: 'A playlist or track is required.' });
        return;
    }

    try {
        const body = playlistId
            ? {
                context_uri: `spotify:playlist:${playlistId}`,
                ...(Number.isInteger(position) ? { offset: { position } } : {})
            }
            : { uris: [trackUri] };

        let playbackError;
        try {
            await spotifyApi('/me/player/play', { method: 'PUT', body });
        } catch (error) {
            playbackError = error;
        }

        if (playbackError?.message.includes('No active device found')) {
            const devices = (await spotifyApi('/me/player/devices')).devices || [];
            const target = devices.find((device) => device.is_active)
                || devices.find((device) => device.type === 'Computer' && !device.is_restricted)
                || devices.find((device) => !device.is_restricted);

            if (!target) {
                throw new Error(
                    'Spotify has no available playback device. Open Spotify Desktop, start playback once, and try again.'
                );
            }

            await spotifyApi('/me/player', {
                method: 'PUT',
                body: { device_ids: [target.id], play: false }
            });
            await spotifyApi('/me/player/play', { method: 'PUT', body });
        } else if (playbackError) {
            throw playbackError;
        }

        res.sendStatus(204);
    } catch (error) {
        console.error('Spotify playback request failed:', error.message);
        res.status(502).json({ error: error.message });
    }
});

app.get('/api/spotify/player-state', async (req, res) => {
    try {
        const state = await spotifyApi('/me/player');
        res.json({
            shuffle: Boolean(state.shuffle_state),
            repeat: state.repeat_state || 'off'
        });
    } catch (error) {
        console.error('Spotify player state request failed:', error.message);
        res.status(502).json({ error: error.message });
    }
});

app.put('/api/spotify/shuffle', async (req, res) => {
    if (typeof req.body.state !== 'boolean') {
        res.status(400).json({ error: 'Shuffle state must be true or false.' });
        return;
    }

    try {
        await spotifyApi(`/me/player/shuffle?state=${req.body.state}`, { method: 'PUT' });
        res.sendStatus(204);
    } catch (error) {
        console.error('Spotify shuffle request failed:', error.message);
        res.status(502).json({ error: error.message });
    }
});

app.put('/api/spotify/repeat', async (req, res) => {
    if (!['off', 'context', 'track'].includes(req.body.state)) {
        res.status(400).json({ error: 'Repeat state must be off, context, or track.' });
        return;
    }

    try {
        await spotifyApi(`/me/player/repeat?state=${req.body.state}`, { method: 'PUT' });
        res.sendStatus(204);
    } catch (error) {
        console.error('Spotify repeat request failed:', error.message);
        res.status(502).json({ error: error.message });
    }
});

// ---- 1. SETUP WEBSOCKET SERVER FOR OBS OVERLAY ----
const wss = new WebSocketServer({ port: 8080 });
console.log('OBS Overlay WebSocket server running on ws://localhost:8080');

wss.on('error', (error) => {
    console.error(`OBS Overlay WebSocket server failed: ${error.message}`);
});

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

function startController() {
    if (controller || controllerRestartTimer) {
        return;
    }

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
        try {
            os.setPriority(controller.pid, highPriority);
            console.log(`Audio controller priority set to HIGH (PID ${controller.pid}).`);
        } catch (error) {
            console.error('Failed to set audio controller priority to HIGH:', error.message);
        }
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
        controllerRestartTimer = setTimeout(() => {
            controllerRestartTimer = null;
            startController();
        }, 2000);
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
        const timeout = setTimeout(() => {
            if (!pendingControllerCommands.delete(id)) return;

            const error = new Error(
                `Audio controller did not respond to "${command}" within ${controllerCommandTimeoutMs} ms.`
            );
            console.error(error.message);
            reject(error);

            if (controller && controller.exitCode === null) {
                controller.kill();
            }
        }, controllerCommandTimeoutMs);

        pendingControllerCommands.set(id, {
            resolve: (result) => {
                clearTimeout(timeout);
                resolve(result);
            },
            reject: (error) => {
                clearTimeout(timeout);
                reject(error);
            }
        });
        try {
            controller.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
                if (!error) return;
                const pending = pendingControllerCommands.get(id);
                if (!pending) return;
                pendingControllerCommands.delete(id);
                pending.reject(error);
            });
        } catch (error) {
            const pending = pendingControllerCommands.get(id);
            if (!pending) return;
            pendingControllerCommands.delete(id);
            pending.reject(error);
        }
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

    try {
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

        await runAudioHelper('passthrough-stop');
        return res.json({ state: 'stopped' });
    } catch (error) {
        console.error('Audio passthrough command failed:', error.message);
        return res.status(500).json({ error: 'Microphone passthrough command failed.' });
    }
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
const httpServer = app.listen(3000, () => {
    console.log('Deckboard API listener running on http://localhost:3000');
    startMediaMonitor();
});

httpServer.on('error', (error) => {
    console.error(`Deckboard API listener failed: ${error.message}`);
});

if (fs.existsSync(certificatePath)) {
    const httpsServer = https.createServer(
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
    httpsServer.on('error', (error) => {
        console.error(`Tablet HTTPS listener failed: ${error.message}`);
    });
} else {
    console.warn(`HTTPS certificate missing: ${certificatePath}`);
}
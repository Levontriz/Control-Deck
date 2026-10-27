const deckContainer = document.getElementById('deckContainer');
const settingsButton = document.getElementById('settingsButton');
const settingsIPButton = document.getElementById('settingsIPButton');
const sleepButton = document.getElementById('sleepButton');
const batteryLevel = document.getElementById('batteryLevel');

let deckConfig = null;
let currentButtons = [];
let folderHistory = [];
let audioStatus = {
    linked: false,
    muted: false,
    available: false
};

let mediaStatus = {
    albumArt: '',
    title: '',
    artist: '',
    available: false
};
let spotifyPlaybackSettings = {
    shuffle: false,
    repeat: 'off'
};

const soundVolumeKey = 'deckboard-sound-levels';







/* =========================================================
   Android Controls
   ========================================================= */

settingsButton.addEventListener('click', () => {
    if (window.Android) {
        Android.openSettings();
    }
});

settingsIPButton.addEventListener('click', () => {
    if (window.Android) {
        Android.openServerSettingsDialog();
    }
});

sleepButton.addEventListener('click', () => {
    if (window.Android) {
        Android.sleep();
    }
});


function refreshBattery() {
    if (!window.Android) {
        batteryLevel.textContent = '--%';
        return;
    }

    try {
        const battery = Android.getBattery();

        if (typeof battery === 'number') {
            batteryLevel.textContent = `${battery}%`;
        } else {
            batteryLevel.textContent = '--%';
        }
    } catch (error) {
        console.error('Failed to read Android battery:', error);
        batteryLevel.textContent = '--%';
    }
}


/* =========================================================
   Sound Volume
   ========================================================= */

function getSoundVolumes() {
    try {
        return JSON.parse(
            localStorage.getItem(soundVolumeKey) || '{}'
        );
    } catch {
        return {};
    }
}

function getSoundLevel(button) {
    const saved = getSoundVolumes()[button.id];

    return typeof saved === 'number'
        ? Math.max(0, Math.min(100, saved))
        : button.volume;
}

function setSoundLevel(button, level, valueElement) {
    const volumes = getSoundVolumes();

    volumes[button.id] = level;

    localStorage.setItem(
        soundVolumeKey,
        JSON.stringify(volumes)
    );

    valueElement.textContent = `${Math.round(level)}%`;
}

function levelToGain(level) {
    if (level <= 0) return 0;

    const decibels = -60 + (level / 100) * 60;

    return Math.pow(10, decibels / 20);
}


/* =========================================================
   Button Configuration
   ========================================================= */

function getConfiguredButton(buttons, id) {
    for (const button of buttons) {
        if (button.id === id) {
            return button;
        }

        if (button.children) {
            const child = getConfiguredButton(button.children, id);

            if (child) {
                return child;
            }
        }
    }

    return null;
}


/* =========================================================
   Button Status
   ========================================================= */

function renderButtonStatus(button, element) {
    if (!button.status) return;

    if (button.status === 'media') {
        renderMediaStatus(element);
        return;
    }

    const statusElement =
        element.querySelector('.button-status');

    if (!statusElement) return;

    const isLinked =
        button.status === 'link' &&
        audioStatus.available &&
        audioStatus.linked;

    const isMuted =
        button.status === 'mic' &&
        audioStatus.available &&
        audioStatus.muted;

    const isActive =
        button.status === 'link'
            ? isLinked
            : !isMuted && audioStatus.available;

    const label =
        button.status === 'link'
            ? (isLinked ? 'LINKED' : 'OFF')
            : (isMuted ? 'MUTED' : 'LIVE');

    statusElement.className =
        `button-status ${isActive ? 'is-active' : ''} ${isMuted ? 'is-muted' : ''} ${!audioStatus.available ? 'is-unknown' : ''}`;

    statusElement.lastElementChild.textContent = label;
}

function renderMediaStatus(element) {
    const image = element.querySelector('.media-art');
    const title = element.querySelector('.media-title');
    const artist = element.querySelector('.media-artist');
    const hasArtwork = mediaStatus.available && mediaStatus.albumArt;

    element.classList.toggle('media-unavailable', !hasArtwork);

    if (hasArtwork) {
        image.src = `data:image/png;base64,${mediaStatus.albumArt}`;
        image.alt = mediaStatus.title || 'Current album art';
    } else {
        image.removeAttribute('src');
        image.alt = 'No media playing';
    }

    title.textContent = mediaStatus.title || 'Nothing playing';
    artist.textContent = mediaStatus.artist || '';

    setupMediaScrolling(element);
}

function setupMediaScrolling(element) {
    element.querySelectorAll('.media-title, .media-artist').forEach((text) => {
        const window = text.parentElement;

        text.classList.remove('is-scrolling');
        text.style.removeProperty('--scroll-distance');

        requestAnimationFrame(() => {
            const overflow = window.scrollWidth - window.clientWidth;

            if (overflow > 2) {
                text.style.setProperty('--scroll-distance', `${overflow}px`);
                text.classList.add('is-scrolling');
            }
        });
    });
}


async function refreshAudioStatus() {
    try {
        const response = await fetch(
            '/api/status',
            {
                cache: 'no-store'
            }
        );

        if (!response.ok) {
            throw new Error('Status request failed');
        }

        const status = await response.json();

        audioStatus = {
            ...status,
            available: true
        };

    } catch (error) {
        audioStatus = {
            linked: false,
            muted: false,
            available: false
        };
    }

    if (!deckConfig) return;

    document
        .querySelectorAll('[data-status-key]')
        .forEach((element) => {
            const button = getConfiguredButton(
                deckConfig.buttons,
                element.dataset.statusKey
            );

            if (button && button.status !== 'media') {
                renderButtonStatus(button, element);
            }
        });
}

function connectMediaStream() {
    const stream = new EventSource('/api/media/stream');

    stream.onmessage = (event) => {
        try {
            mediaStatus = {
                ...JSON.parse(event.data),
                available: true
            };
        } catch (error) {
            console.error('Invalid media stream event:', error);
            return;
        }

        document
            .querySelectorAll('[data-status-key]')
            .forEach((element) => {
                const button = getConfiguredButton(
                    deckConfig?.buttons || [],
                    element.dataset.statusKey
                );

                if (button?.status === 'media') {
                    renderMediaStatus(element);
                }
            });
    };

    stream.onerror = () => {
        mediaStatus.available = false;
        stream.close();
        setTimeout(connectMediaStream, 2000);
    };
}


/* =========================================================
   Initialise Deck
   ========================================================= */

async function initDeck() {
    try {
        const response = await fetch(`config.json?version=${Date.now()}`, {
            cache: 'no-store'
        });

        deckConfig = await response.json();

        deckContainer.style.gridTemplateColumns =
            `repeat(${deckConfig.grid.columns}, 1fr)`;

        deckContainer.style.gridTemplateRows =
            `repeat(${deckConfig.grid.rows}, 1fr)`;

        currentButtons = deckConfig.buttons;

        renderGrid();

    } catch (err) {
        console.error(
            'Failed to load Stream Deck configurations:',
            err
        );
    }
}


/* =========================================================
   Render Grid
   ========================================================= */

function renderGrid(animation = null) {

    function buildGrid() {
        deckContainer.innerHTML = '';

        const totalSlots =
            deckConfig.grid.columns *
            deckConfig.grid.rows;

        const buttonMap = {};

        // Add Back button when inside a folder.
        if (folderHistory.length > 0) {
            buttonMap[1] = {
                label: '↩ Back',
                type: 'back_navigation'
            };
        }

        // Add configured buttons.
        currentButtons.forEach((btn) => {
            if (
                folderHistory.length > 0 &&
                btn.position === 1
            ) {
                return;
            }

            buttonMap[btn.position] = btn;
        });

        // Build every grid slot.
        for (let slot = 1; slot <= totalSlots; slot++) {
            const targetBtn = buttonMap[slot];

            const el = document.createElement('button');

            el.className = 'deck-button';

            if (targetBtn) {

                const volumeControl =
                    typeof targetBtn.volume === 'number'
                        ? `
                            <span class="volume-control">
                                <span class="volume-label">
                                    Volume
                                    <strong>
                                        ${Math.round(
                                            getSoundLevel(targetBtn)
                                        )}%
                                    </strong>
                                </span>

                                <input
                                    class="volume-slider"
                                    type="range"
                                    min="0"
                                    max="100"
                                    step="1"
                                    value="${getSoundLevel(targetBtn)}"
                                    aria-label="${targetBtn.label} volume"
                                >
                            </span>
                        `
                        : '';

                const statusControl =
                    targetBtn.status && targetBtn.status !== 'media'
                        ? `
                            <span class="button-status is-unknown">
                                <span class="status-dot"></span>
                                <span>CHECKING</span>
                            </span>
                        `
                        : '';

                const mediaControl = targetBtn.status === 'media'
                    ? `
                        <span class="media-status-content">
                            <span class="vinyl-record" aria-hidden="true">
                                <img class="media-art" alt="No media playing">
                                <span class="vinyl-spindle"></span>
                            </span>
                            <span class="media-copy">
                                <span class="media-text-window">
                                    <span class="media-title">Nothing playing</span>
                                </span>
                                <span class="media-text-window">
                                    <span class="media-artist"></span>
                                </span>
                            </span>
                        </span>
                    `
                    : '';

                el.innerHTML = `
                    <span class="button-label">
                        ${targetBtn.label}
                    </span>

                    ${mediaControl}

                    ${volumeControl}

                    ${statusControl}
                `;

                if (targetBtn.status) {
                    el.dataset.statusKey = targetBtn.id;
                    renderButtonStatus(targetBtn, el);
                }

                // Volume slider.
                const slider =
                    el.querySelector('.volume-slider');

                if (slider) {
                    const valueElement =
                        el.querySelector('.volume-label strong');

                    slider.addEventListener(
                        'pointerdown',
                        (event) => event.stopPropagation()
                    );

                    slider.addEventListener(
                        'click',
                        (event) => event.stopPropagation()
                    );

                    slider.addEventListener(
                        'input',
                        () => {
                            setSoundLevel(
                                targetBtn,
                                Number(slider.value),
                                valueElement
                            );
                        }
                    );
                }

                // Button actions.
                if (targetBtn.type === 'back_navigation') {

                    el.classList.add('nav-button');

                    el.addEventListener(
                        'click',
                        navigateBack
                    );

                } else if (targetBtn.type === 'folder') {

                    el.classList.add('folder-button');

                    el.addEventListener(
                        'click',
                        () => enterFolder(targetBtn)
                    );

                } else if (targetBtn.type === 'spotify_folder') {

                    el.classList.add('folder-button');

                    el.addEventListener(
                        'click',
                        () => openSpotifyFolder()
                    );

                } else if (targetBtn.type === 'spotify_playlist') {

                    el.classList.add('folder-button');

                    el.addEventListener(
                        'click',
                        () => openSpotifyPlaylist(targetBtn)
                    );

                } else if (targetBtn.type === 'spotify_next') {

                    el.addEventListener(
                        'click',
                        targetBtn.onClick
                    );

                } else if (targetBtn.type === 'spotify_control') {

                    el.addEventListener(
                        'click',
                        targetBtn.onClick
                    );

                } else if (targetBtn.type === 'spotify_track_menu') {

                    el.addEventListener(
                        'click',
                        targetBtn.onClick
                    );

                } else if (targetBtn.type === 'spotify_connect') {

                    el.addEventListener(
                        'click',
                        () => { window.location.href = '/api/spotify/login'; }
                    );

                } else if (targetBtn.type === 'spotify_setup') {

                    el.addEventListener(
                        'click',
                        () => console.error('Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REDIRECT_URI on the server first.')
                    );

                } else if (targetBtn.type === 'action') {

                    el.addEventListener(
                        'click',
                        () => fireMacroAction(targetBtn)
                    );
                }

            } else {

                // Empty slot.
                el.classList.add('empty-slot');
                el.disabled = true;
            }

            deckContainer.appendChild(el);
        }
    }


    /*
     * Initial render does not need an animation.
     */
    if (!animation) {
        buildGrid();
        return;
    }


    /*
     * Animate the current folder out.
     */
    if (animation === 'forward') {
        deckContainer.classList.add('deck-exit-left');
    } else {
        deckContainer.classList.add('deck-exit-right');
    }


    /*
     * Wait for the exit animation before
     * replacing the buttons.
     */
    setTimeout(() => {

        deckContainer.classList.remove(
            'deck-exit-left',
            'deck-exit-right'
        );

        buildGrid();


        /*
         * Animate the new folder in.
         */
        if (animation === 'forward') {
            deckContainer.classList.add(
                'deck-enter-right'
            );
        } else {
            deckContainer.classList.add(
                'deck-enter-left'
            );
        }


        /*
         * Stagger the individual buttons.
         */
        const buttons =
            deckContainer.querySelectorAll(
                '.deck-button'
            );

        buttons.forEach((button, index) => {

            button.classList.add(
                'deck-button-enter'
            );

            button.style.animationDelay =
                `${Math.min(index * 18, 180)}ms`;
        });


        /*
         * Remove animation classes when finished.
         */
        setTimeout(() => {

            deckContainer.classList.remove(
                'deck-enter-right',
                'deck-enter-left'
            );

            buttons.forEach((button) => {
                button.classList.remove(
                    'deck-button-enter'
                );

                button.style.animationDelay = '';
            });

        }, 400);

    }, 180);
}


/* =========================================================
   Folder Navigation
   ========================================================= */

function enterFolder(folderBtn) {
    folderHistory.push(currentButtons);

    currentButtons = folderBtn.children || [];

    renderGrid('forward');
}


function navigateBack() {
    if (folderHistory.length > 0) {
        currentButtons = folderHistory.pop();

        renderGrid('back');
    }
}

async function openSpotifyFolder() {
    try {
        const statusResponse = await fetch('/api/spotify/status', { cache: 'no-store' });
        const status = await statusResponse.json();

        if (!status.configured || !status.connected) {
            folderHistory.push(currentButtons);
            currentButtons = [{
                id: 'spotify_connect',
                position: 2,
                label: status.configured ? '🔗 Connect Spotify' : '⚙ Configure Spotify',
                type: status.configured ? 'spotify_connect' : 'spotify_setup'
            }];
            renderGrid('forward');
            return;
        }

        const response = await fetch('/api/spotify/playlists', { cache: 'no-store' });
        if (!response.ok) throw new Error((await response.json()).error || 'Could not load Spotify playlists.');
        const playlists = await response.json();

        folderHistory.push(currentButtons);
        renderSpotifyPlaylistPage(playlists, 0, true);
    } catch (error) {
        console.error('Failed to load Spotify playlists:', error);
    }
}

async function openSpotifyPlaylist(button) {
    try {
        const response = await fetch(
            `/api/spotify/playlists/${encodeURIComponent(button.playlist.id)}/tracks`,
            { cache: 'no-store' }
        );
        if (!response.ok) throw new Error((await response.json()).error || 'Could not load Spotify tracks.');
        const tracks = await response.json();

        const stateResponse = await fetch('/api/spotify/player-state', { cache: 'no-store' });
        if (stateResponse.ok) {
            spotifyPlaybackSettings = await stateResponse.json();
        }

        folderHistory.push(currentButtons);
        renderSpotifyTrackPage(button.playlist, tracks, 0, true);
    } catch (error) {
        console.error('Failed to load Spotify playlist tracks:', error);
    }
}

function renderSpotifyPlaylistPage(playlists, page, animate) {
    const pageSize = 13;
    const start = page * pageSize;
    currentButtons = playlists.slice(start, start + pageSize).map((playlist, index) => ({
        id: `spotify_playlist_${playlist.id}`,
        position: index + 2,
        label: `🎵 ${playlist.name}`,
        type: 'spotify_playlist',
        playlist
    }));
    if (start + pageSize < playlists.length) {
        currentButtons.push({
            id: 'spotify_next_playlists',
            position: 15,
            label: 'Next Playlists ▶',
            type: 'spotify_next',
            onClick: () => renderSpotifyPlaylistPage(playlists, page + 1, true)
        });
    }
    renderGrid(animate ? 'forward' : null);
}

function renderSpotifyTrackPage(playlist, tracks, page, animate) {
    currentButtons = [{
        id: `spotify_play_${playlist.id}`,
        position: 2,
        label: '▶ Play Playlist',
        type: 'action',
        endpoint: '/api/spotify/play',
        method: 'PUT',
        payload: { playlistId: playlist.id }
    }, {
        id: `spotify_shuffle_${playlist.id}`,
        position: 3,
        label: `🔀 Shuffle: ${spotifyPlaybackSettings.shuffle ? 'On' : 'Off'}`,
        type: 'spotify_control',
        onClick: () => toggleSpotifyShuffle()
    }, {
        id: `spotify_repeat_${playlist.id}`,
        position: 4,
        label: `🔁 Repeat: ${spotifyPlaybackSettings.repeat}`,
        type: 'spotify_control',
        onClick: () => cycleSpotifyRepeat()
    }, {
        id: `spotify_tracks_${playlist.id}`,
        position: 5,
        label: `🎵 Browse Tracks (${tracks.length})`,
        type: 'spotify_track_menu',
        onClick: () => openSpotifyTrackMenu(playlist, tracks)
    }];
    renderGrid(animate ? 'forward' : null);
}

async function updateSpotifyControl(endpoint, payload) {
    const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Spotify control request failed.');
    }
}

async function toggleSpotifyShuffle() {
    const nextState = !spotifyPlaybackSettings.shuffle;
    try {
        await updateSpotifyControl('/api/spotify/shuffle', { state: nextState });
        spotifyPlaybackSettings.shuffle = nextState;
        renderGrid();
    } catch (error) {
        console.error('Failed to change Spotify shuffle:', error);
    }
}

async function cycleSpotifyRepeat() {
    const modes = ['off', 'context', 'track'];
    const nextState = modes[(modes.indexOf(spotifyPlaybackSettings.repeat) + 1) % modes.length];
    try {
        await updateSpotifyControl('/api/spotify/repeat', { state: nextState });
        spotifyPlaybackSettings.repeat = nextState;
        renderGrid();
    } catch (error) {
        console.error('Failed to change Spotify repeat:', error);
    }
}

function openSpotifyTrackMenu(playlist, tracks) {
    const overlay = document.createElement('div');
    overlay.className = 'spotify-track-overlay';
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) overlay.remove();
    });

    const panel = document.createElement('section');
    panel.className = 'spotify-track-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');

    const heading = document.createElement('div');
    heading.className = 'spotify-track-heading';
    heading.innerHTML = `<h2></h2><button type="button" aria-label="Close track list">✕</button>`;
    heading.querySelector('h2').textContent = playlist.name;
    heading.querySelector('button').addEventListener('click', () => overlay.remove());

    const list = document.createElement('div');
    list.className = 'spotify-track-list';
    tracks.forEach((track) => {
        const button = document.createElement('button');
        button.className = 'spotify-track-item';
        button.type = 'button';
        button.textContent = `${track.name} — ${track.artist}`;
        button.addEventListener('click', async () => {
            try {
                const played = await fireMacroAction({
                    id: `spotify_track_${track.id}`,
                    endpoint: '/api/spotify/play',
                    method: 'PUT',
                    payload: {
                        playlistId: playlist.id,
                        position: track.position
                    }
                });
                if (played) overlay.remove();
            } catch (error) {
                console.error('Failed to play Spotify track:', error);
            }
        });
        list.appendChild(button);
    });

    panel.append(heading, list);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
}


/* =========================================================
   API Action Dispatcher
   ========================================================= */

async function fireMacroAction(btnConfig) {
    try {
        const response = await fetch(
            btnConfig.endpoint,
            {
                method: btnConfig.method || 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(
                    btnConfig.volume === undefined
                        ? btnConfig.payload
                        : {
                            ...btnConfig.payload,
                            volume: levelToGain(
                                getSoundLevel(btnConfig)
                            )
                        }
                )
            }
        );

        if (response.ok) {
            console.log(
                `Action [${btnConfig.id}] sent successfully.`
            );

            refreshAudioStatus();
            return true;

        } else {
            console.error(
                `Endpoint error for action [${btnConfig.id}]`
            );
            return false;
        }

    } catch (error) {
        console.error(
            'Network communication breakdown:',
            error
        );
        return false;
    }
}


/* =========================================================
   Start Control Deck
   ========================================================= */

initDeck();

refreshAudioStatus();
connectMediaStream();

refreshBattery();

setInterval(
    refreshAudioStatus,
    2000
);

setInterval(
    refreshBattery,
    30000
);
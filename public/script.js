const deckContainer = document.getElementById('deckContainer');
const fullscreenOverlay = document.getElementById('fullscreenOverlay');
const fullscreenButton = document.getElementById('fullscreenButton');

let deckConfig = null;
let currentButtons = [];
let folderHistory = []; // Tracks open folder trees
let fullscreenRequested = false;
let audioStatus = { linked: false, muted: false, available: false };
const soundVolumeKey = 'deckboard-sound-levels';

function getSoundVolumes() {
    try {
        return JSON.parse(localStorage.getItem(soundVolumeKey) || '{}');
    } catch {
        return {};
    }
}

function getSoundLevel(button) {
    const saved = getSoundVolumes()[button.id];
    return typeof saved === 'number' ? Math.max(0, Math.min(100, saved)) : button.volume;
}

function setSoundLevel(button, level, valueElement) {
    const volumes = getSoundVolumes();
    volumes[button.id] = level;
    localStorage.setItem(soundVolumeKey, JSON.stringify(volumes));
    valueElement.textContent = `${Math.round(level)}%`;
}

function levelToGain(level) {
    if (level <= 0) return 0;
    const decibels = -60 + (level / 100) * 60;
    return Math.pow(10, decibels / 20);
}

function getConfiguredButton(buttons, id) {
    for (const button of buttons) {
        if (button.id === id) return button;
        if (button.children) {
            const child = getConfiguredButton(button.children, id);
            if (child) return child;
        }
    }
    return null;
}

function renderButtonStatus(button, element) {
    if (!button.status) return;

    const statusElement = element.querySelector('.button-status');
    if (!statusElement) return;

    const isLinked = button.status === 'link' && audioStatus.available && audioStatus.linked;
    const isMuted = button.status === 'mic' && audioStatus.available && audioStatus.muted;
    const isActive = button.status === 'link' ? isLinked : !isMuted && audioStatus.available;
    const label = button.status === 'link'
        ? (isLinked ? 'LINKED' : 'OFF')
        : (isMuted ? 'MUTED' : 'LIVE');

    statusElement.className = `button-status ${isActive ? 'is-active' : ''} ${isMuted ? 'is-muted' : ''} ${!audioStatus.available ? 'is-unknown' : ''}`;
    statusElement.lastElementChild.textContent = label;
}

async function refreshAudioStatus() {
    try {
        const response = await fetch('/api/status', { cache: 'no-store' });
        if (!response.ok) throw new Error('Status request failed');
        const status = await response.json();
        audioStatus = { ...status, available: true };
    } catch (error) {
        audioStatus = { linked: false, muted: false, available: false };
    }
    document.querySelectorAll('[data-status-key]').forEach((element) => {
        const button = getConfiguredButton(deckConfig.buttons, element.dataset.statusKey);
        if (button) renderButtonStatus(button, element);
    });
}

// Handle hardware/browser full screen constraints
async function requestMobileFullscreen() {
    const fullscreenMethod = document.documentElement.requestFullscreen
        || document.documentElement.webkitRequestFullscreen;

    if (fullscreenRequested || document.fullscreenElement || !fullscreenMethod) {
        return false;
    }

    fullscreenRequested = true;
    try {
        await fullscreenMethod.call(document.documentElement, { navigationUI: 'hide' });
        return true;
    } catch (error) {
        fullscreenRequested = false;
        return false;
    }
}

// Initialization configuration step
async function initDeck() {
    try {
        const response = await fetch('config.json');
        deckConfig = await response.json();
        
        // Dynamically style your CSS variables based on JSON parameters
        deckContainer.style.gridTemplateColumns = `repeat(${deckConfig.grid.columns}, 1fr)`;
        deckContainer.style.gridTemplateRows = `repeat(${deckConfig.grid.rows}, 1fr)`;
        
        currentButtons = deckConfig.buttons;
        renderGrid();
    } catch (err) {
        console.error("Failed to load Stream Deck configurations:", err);
    }
}

// Compile UI button cards cleanly into grid elements
function renderGrid() {
    deckContainer.innerHTML = '';
    const totalSlots = deckConfig.grid.columns * deckConfig.grid.rows;
    
    // Create an array map matching position allocations
    const buttonMap = {};
    
    // Inject a persistent return navigation button if inside a subfolder
    if (folderHistory.length > 0) {
        buttonMap[1] = {
            label: "↩ Back",
            type: "back_navigation"
        };
    }

    currentButtons.forEach(btn => {
        // Skip slot 1 if it is overridden by the global Back button
        if (folderHistory.length > 0 && btn.position === 1) return;
        buttonMap[btn.position] = btn;
    });

    // Populate every single available grid slot block explicitly
    for (let slot = 1; slot <= totalSlots; slot++) {
        const targetBtn = buttonMap[slot];
        const el = document.createElement('button');
        el.className = 'deck-button';

        if (targetBtn) {
            const volumeControl = typeof targetBtn.volume === 'number'
                ? `<span class="volume-control"><span class="volume-label">Volume <strong>${Math.round(getSoundLevel(targetBtn))}%</strong></span><input class="volume-slider" type="range" min="0" max="100" step="1" value="${getSoundLevel(targetBtn)}" aria-label="${targetBtn.label} volume"></span>`
                : '';
            el.innerHTML = `<span class="button-label">${targetBtn.label}</span>${volumeControl}${targetBtn.status ? '<span class="button-status is-unknown"><span class="status-dot"></span><span>CHECKING</span></span>' : ''}`;
            if (targetBtn.status) el.dataset.statusKey = targetBtn.id;
            renderButtonStatus(targetBtn, el);

            const slider = el.querySelector('.volume-slider');
            if (slider) {
                const valueElement = el.querySelector('.volume-label strong');
                slider.addEventListener('pointerdown', (event) => event.stopPropagation());
                slider.addEventListener('click', (event) => event.stopPropagation());
                slider.addEventListener('input', () => setSoundLevel(targetBtn, Number(slider.value), valueElement));
            }
            
            // Map actions based on configuration payload types
            if (targetBtn.type === 'back_navigation') {
                el.classList.add('nav-button');
                el.addEventListener('click', navigateBack);
            } else if (targetBtn.type === 'folder') {
                el.classList.add('folder-button');
                el.addEventListener('click', () => enterFolder(targetBtn));
            } else if (targetBtn.type === 'action') {
                el.addEventListener('click', () => fireMacroAction(targetBtn));
            }
        } else {
            // Unmapped empty buttons for geometric consistency
            el.classList.add('empty-slot');
            el.disabled = true;
        }
        deckContainer.appendChild(el);
    }
}

// Navigation Layer Changes
function enterFolder(folderBtn) {
    requestMobileFullscreen();
    folderHistory.push(currentButtons);
    currentButtons = folderBtn.children || [];
    renderGrid();
}

function navigateBack() {
    requestMobileFullscreen();
    if (folderHistory.length > 0) {
        currentButtons = folderHistory.pop();
        renderGrid();
    }
}

// Unified dynamic API dispatcher
async function fireMacroAction(btnConfig) {
    requestMobileFullscreen();
    try {
        const response = await fetch(btnConfig.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(btnConfig.volume === undefined
                ? btnConfig.payload
                : { ...btnConfig.payload, volume: levelToGain(getSoundLevel(btnConfig)) })
        });
        if (response.ok) {
            console.log(`Action [${btnConfig.id}] sent successfully.`);
            refreshAudioStatus();
        } else {
            console.error(`Endpoint error for action [${btnConfig.id}]`);
        }
    } catch (error) {
        console.error(`Network communication breakdown:`, error);
    }
}

// Setup full layout listeners
fullscreenButton.addEventListener('click', async () => {
    if (await requestMobileFullscreen()) {
        fullscreenOverlay.classList.add('is-hidden');
    }
});
document.addEventListener('pointerdown', requestMobileFullscreen, { once: true });

// Boot deckboard system
initDeck();
refreshAudioStatus();
setInterval(refreshAudioStatus, 2000);

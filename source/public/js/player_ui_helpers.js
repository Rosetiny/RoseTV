// Player UI Helper Functions

function showShortcutHint(text, direction) {
    const hintElement = document.getElementById('shortcutHint');
    const textElement = document.getElementById('shortcutText');
    const iconElement = document.getElementById('shortcutIcon');
    if (shortcutHintTimeout) clearTimeout(shortcutHintTimeout);
    textElement.textContent = text;
    iconElement.innerHTML = direction === 'left' ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path>' : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>';
    hintElement.classList.add('show');
    shortcutHintTimeout = setTimeout(() => hintElement.classList.remove('show'), 2000);
}

function showError(message) {
    // This function assumes hlsPlaybackStarted and errorDisplayedGlobal are accessible from its scope
    // (i.e., they are global or in a shared outer scope like initPlayer, and showError is defined within/after initPlayer or globally).
    // These variables (hlsPlaybackStarted, errorDisplayedGlobal, dp) would need to be accessible, e.g. from player_vars.js
    if (typeof errorDisplayedGlobal !== 'undefined' && errorDisplayedGlobal) {
        console.log('showError called, but error already displayed (errorDisplayedGlobal=true):', message);
        return;
    }
    if (typeof hlsPlaybackStarted !== 'undefined' && hlsPlaybackStarted && dp && dp.video && dp.video.currentTime > 0.5) {
        console.log('showError called, but video seems to be playing (hlsPlaybackStarted=true, currentTime > 0.5):', message);
        return;
    }
    
    console.error('Showing error:', message); 
    
    if (typeof errorDisplayedGlobal !== 'undefined') {
        errorDisplayedGlobal = true; 
    }
    
    document.getElementById('loading').style.display = 'none';
    document.getElementById('error').style.display = 'flex';
    document.getElementById('error-message').textContent = message;
}

function updateEpisodeInfo() {
    if (currentEpisodes.length > 0) { // Assumes currentEpisodes is globally available (e.g. from player_vars.js)
        document.getElementById('episodeInfo').textContent = `第 ${currentEpisodeIndex + 1}/${currentEpisodes.length} 集`;
    } else {
        document.getElementById('episodeInfo').textContent = '无集数信息';
    }
}

function updateButtonStates() {
    const prevButton = document.getElementById('prevButton');
    const nextButton = document.getElementById('nextButton');
    
    if (currentEpisodeIndex > 0) { // Assumes currentEpisodeIndex is globally available
        prevButton.classList.remove('bg-gray-700', 'cursor-not-allowed');
        prevButton.classList.add('bg-[#222]', 'hover:bg-[#333]');
        prevButton.removeAttribute('disabled');
    } else {
        prevButton.classList.add('bg-gray-700', 'cursor-not-allowed');
        prevButton.classList.remove('bg-[#222]', 'hover:bg-[#333]');
        prevButton.setAttribute('disabled', '');
    }
    
    if (currentEpisodeIndex < currentEpisodes.length - 1) { // Assumes currentEpisodes is globally available
        nextButton.classList.remove('bg-gray-700', 'cursor-not-allowed');
        nextButton.classList.add('bg-[#222]', 'hover:bg-[#333]');
        nextButton.removeAttribute('disabled');
    } else {
        nextButton.classList.add('bg-gray-700', 'cursor-not-allowed');
        nextButton.classList.remove('bg-[#222]', 'hover:bg-[#333]');
        nextButton.setAttribute('disabled', '');
    }
}

function renderEpisodes() {
    // Assumes currentEpisodes, episodesReversed, currentEpisodeIndex are globally available (e.g. from player_vars.js)
    // Assumes playEpisode is globally available (e.g. from player_core_logic.js)
    console.log('[PlayerDebug] renderEpisodes called.');
    const episodesList = document.getElementById('episodesList');
    if (!episodesList) return;
    
    if (!currentEpisodes || currentEpisodes.length === 0) {
        episodesList.innerHTML = '<div class="col-span-full text-center text-gray-400 py-8">没有可用的集数</div>';
        return;
    }
    
    const episodesToRender = episodesReversed ? [...currentEpisodes].reverse() : currentEpisodes;
    let html = '';
    
    episodesToRender.forEach((episodeUrl, indexInRenderedList) => {
        const realIndex = episodesReversed ? currentEpisodes.length - 1 - indexInRenderedList : indexInRenderedList;
        const isActive = realIndex === currentEpisodeIndex;
        
        html += `
            <button id="episode-${realIndex}" 
                    onclick="playEpisode(${realIndex})" 
                    class="px-4 py-2 ${isActive ? 'episode-active' : '!bg-[#222] hover:!bg-[#333] hover:!shadow-none'} !border ${isActive ? '!border-blue-500' : '!border-[#333]'} rounded-lg transition-colors text-center episode-btn">
                第${realIndex + 1}集
            </button>
        `;
    });
    episodesList.innerHTML = html;
}

function updateOrderButton() {
    // Assumes episodesReversed is globally available
    const orderText = document.getElementById('orderText');
    const orderIcon = document.getElementById('orderIcon');
    
    if (orderText && orderIcon) {
        orderText.textContent = episodesReversed ? '正序排列' : '倒序排列';
        orderIcon.style.transform = episodesReversed ? 'rotate(180deg)' : '';
    }
}

function showPositionRestoreHint(position) {
    if (!position || position < 10) return;
    const hint = document.createElement('div');
    hint.className = 'position-restore-hint';
    hint.innerHTML = `<div class="hint-content">已从 ${formatTime(position)} 继续播放</div>`;
    
    const playerContainer = document.querySelector('.player-container'); 
    if (playerContainer) { 
        playerContainer.appendChild(hint);
    } else {
        console.warn("Player container not found for position hint.");
        return; 
    }
    
    setTimeout(() => {
        hint.classList.add('show');
        setTimeout(() => {
            hint.classList.remove('show');
            setTimeout(() => hint.remove(), 300);
        }, 3000);
    }, 100);
}

function formatTime(seconds) {
    if (isNaN(seconds)) return '00:00';
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

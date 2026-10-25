// 更新播放视频函数，修改为在新标签页中打开播放页面，并保存到历史记录
function playVideo(url, vod_name, sourceCode, episodeIndex = 0) {
    // 密码保护校验
    if (window.isPasswordProtected && window.isPasswordVerified) { // Assuming these are globally available
        if (window.isPasswordProtected() && !window.isPasswordVerified()) {
            if (typeof showPasswordModal === 'function') showPasswordModal(); else console.error("showPasswordModal not defined");
            return;
        }
    }
    if (!url) {
        if (typeof showToast === 'function') showToast('无效的视频链接', 'error'); else console.warn('showToast not defined');
        return;
    }
    
    let sourceName = '';
    const modalTitleEl = document.getElementById('modalTitle'); // Corrected from modalTitle
    if (modalTitleEl) {
        const sourceSpan = modalTitleEl.querySelector('span.text-gray-400');
        if (sourceSpan) {
            const sourceText = sourceSpan.textContent;
            const match = sourceText.match(/\(([^)]+)\)/);
            if (match && match[1]) {
                sourceName = match[1].trim();
            }
        }
    }
    
    // currentVideoTitle, currentEpisodeIndex, currentEpisodes, episodesReversed from app_globals.js
    const currentVideoTitleForStorage = vod_name || currentVideoTitle;
    localStorage.setItem('currentVideoTitle', currentVideoTitleForStorage);
    localStorage.setItem('currentEpisodeIndex', episodeIndex);
    localStorage.setItem('currentEpisodes', JSON.stringify(currentEpisodes)); // Store the global currentEpisodes
    localStorage.setItem('episodesReversed', episodesReversed);

    const modal = document.getElementById('modal');
    if (modal) {
        modal.classList.add('hidden'); 
        console.log('[AppPlayVideo] Detail modal hidden.');
    } else {
        console.warn('[AppPlayVideo] Detail modal element not found to hide.');
    }
    
    const videoTitleForHistory = vod_name || currentVideoTitle;
    const videoInfo = {
        title: videoTitleForHistory,
        url: url,
        episodeIndex: episodeIndex,
        sourceName: sourceName,
        timestamp: Date.now(),
        episodes: currentEpisodes && currentEpisodes.length > 0 ? [...currentEpisodes] : [] // Use global currentEpisodes
    };
    
    // addToViewingHistory is assumed to be global or in another module (e.g., history.js)
    if (typeof addToViewingHistory === 'function') {
        addToViewingHistory(videoInfo);
    } else {
        console.warn("addToViewingHistory function not found.");
    }
    
    const playerUrl = `player.html?url=${encodeURIComponent(url)}&title=${encodeURIComponent(videoTitleForHistory)}&index=${episodeIndex}&source=${encodeURIComponent(sourceName)}&source_code=${encodeURIComponent(sourceCode)}`;
    showVideoPlayer(playerUrl);
}

// 弹出播放器页面 (修改为标准页面导航)
function showVideoPlayer(url) {
    console.log('[AppNavigation] Navigating to player URL:', url);
    window.location.href = url;
}

// 关闭播放器页面 (此函数不再由 player.js 中的 goBack 调用)
// Kept for potential other uses or if legacy calls exist.
function closeVideoPlayer() {
    console.log('[AppNavigation] closeVideoPlayer called. With full page navigation for player, this function might be obsolete or behave differently.');
    const resultsArea = document.getElementById('resultsArea');
    if (resultsArea && resultsArea.classList.contains('hidden')) {
        resultsArea.classList.remove('hidden');
        console.log('[AppNavigation] Made resultsArea visible upon returning to index.html (if closeVideoPlayer is somehow still called).');
    }

    // resetSearchArea from app_event_listeners.js
    if (typeof resetSearchArea === 'function') {
        console.log('[AppNavigation] Calling resetSearchArea if closeVideoPlayer is still triggered.');
        resetSearchArea();
    }
}

// 播放上一集
function playPreviousEpisode(sourceCode) {
    // currentEpisodeIndex, currentEpisodes, currentVideoTitle from app_globals.js
    if (currentEpisodeIndex > 0) {
        const prevIndex = currentEpisodeIndex - 1;
        const prevUrl = currentEpisodes[prevIndex];
        playVideo(prevUrl, currentVideoTitle, sourceCode, prevIndex);
    }
}

// 播放下一集
function playNextEpisode(sourceCode) {
    // currentEpisodeIndex, currentEpisodes, currentVideoTitle from app_globals.js
    if (currentEpisodeIndex < currentEpisodes.length - 1) {
        const nextIndex = currentEpisodeIndex + 1;
        const nextUrl = currentEpisodes[nextIndex];
        playVideo(nextUrl, currentVideoTitle, sourceCode, nextIndex);
    }
}

// 处理播放器加载错误
function handlePlayerError() {
    // hideLoading and showToast are assumed to be global or in ui.js
    if (typeof hideLoading === 'function') hideLoading(); else console.log("Loading complete (error).");
    if (typeof showToast === 'function') showToast('视频播放加载失败，请尝试其他视频源', 'error'); else console.error('Player load error.');
}

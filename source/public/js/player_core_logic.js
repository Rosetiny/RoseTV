// Player Core Logic & Initialization

// Assumes all global variables from player_vars.js are accessible
// Assumes UI helper functions from player_ui_helpers.js are accessible
// Assumes utility functions from player_utils.js are accessible
// Assumes DPlayer handler initPlayer from player_dplayer_handler.js is accessible
// Assumes isPasswordVerified from password.js is accessible

document.addEventListener('DOMContentLoaded', function() {
    if (!isPasswordVerified()) {
        const loadingElement = document.getElementById('loading');
        if (loadingElement) loadingElement.style.display = 'none';
        return;
    }
    initializePageContent();
});

document.addEventListener('passwordVerified', () => {
    const loadingElement = document.getElementById('loading');
    if (loadingElement) loadingElement.style.display = 'block'; // Or 'flex' if that's the intended display type
    initializePageContent();
});

function initializePageContent() {
    const urlParams = new URLSearchParams(window.location.search);
    let videoUrl = urlParams.get('url');
    const title = urlParams.get('title');
    const sourceCode = urlParams.get('source_code');
    let index = parseInt(urlParams.get('index') || '0');
    const episodesListParam = urlParams.get('episodes'); // Renamed to avoid conflict
    // const savedPosition = parseInt(urlParams.get('position') || '0'); // This is handled inside initPlayer

    if (videoUrl && videoUrl.includes('player.html')) {
        try {
            const nestedUrlParams = new URLSearchParams(videoUrl.split('?')[1]);
            const nestedVideoUrl = nestedUrlParams.get('url');
            if (nestedVideoUrl) {
                videoUrl = nestedVideoUrl;
                const currentUrl = new URL(window.location.href);
                ['position', 'index', 'title'].forEach(pKey => {
                    const nestedVal = nestedUrlParams.get(pKey);
                    if (!urlParams.has(pKey) && nestedVal) currentUrl.searchParams.set(pKey, nestedVal);
                });
                window.history.replaceState({}, '', currentUrl);
            } else { 
                if(typeof showError === 'function') showError('历史记录链接无效，请返回首页重新访问'); 
            }
        } catch (e) { console.error('解析嵌套URL出错:', e); }
    }
    
    currentVideoUrl = videoUrl || ''; // From player_vars.js
    currentVideoTitle = title || localStorage.getItem('currentVideoTitle') || '未知视频';
    currentEpisodeIndex = index;
    
    autoplayEnabled = localStorage.getItem('autoplayEnabled') !== 'false';
    const autoplayToggleElement = document.getElementById('autoplayToggle');
    if (autoplayToggleElement) autoplayToggleElement.checked = autoplayEnabled;
    
    adFilteringEnabled = localStorage.getItem(PLAYER_CONFIG.adFilteringStorage) !== 'false';
    
    if (autoplayToggleElement) {
        autoplayToggleElement.addEventListener('change', function(e) {
            autoplayEnabled = e.target.checked;
            localStorage.setItem('autoplayEnabled', autoplayEnabled);
        });
    }
    
    try {
        currentEpisodes = episodesListParam ? JSON.parse(decodeURIComponent(episodesListParam)) : JSON.parse(localStorage.getItem('currentEpisodes') || '[]');
        if (index < 0 || (currentEpisodes.length > 0 && index >= currentEpisodes.length)) {
            index = (index >= currentEpisodes.length && currentEpisodes.length > 0) ? currentEpisodes.length - 1 : 0;
            const newUrl = new URL(window.location.href);
            newUrl.searchParams.set('index', index);
            window.history.replaceState({}, '', newUrl);
        }
        currentEpisodeIndex = index;
        episodesReversed = localStorage.getItem('episodesReversed') === 'true';
    } catch (e) {
        console.error('获取集数信息失败:', e);
        currentEpisodes = []; currentEpisodeIndex = 0; episodesReversed = false;
    }

    document.title = currentVideoTitle + ' - RoseTV播放器';
    const videoTitleElement = document.getElementById('videoTitle');
    if (videoTitleElement) videoTitleElement.textContent = currentVideoTitle;

    if (videoUrl) {
        if(typeof initPlayer === 'function') initPlayer(videoUrl, sourceCode);
    } else {
        if(typeof showError === 'function') showError('无效的视频链接');
    }

    if(typeof updateEpisodeInfo === 'function') updateEpisodeInfo();
    if(typeof renderEpisodes === 'function') renderEpisodes();
    if(typeof updateButtonStates === 'function') updateButtonStates();
    if(typeof updateOrderButton === 'function') updateOrderButton();
    
    setTimeout(() => { if(typeof setupProgressBarPreciseClicks === 'function') setupProgressBarPreciseClicks(); }, 1000);
    document.addEventListener('keydown', handleKeyboardShortcuts); // Assumes handleKeyboardShortcuts is in player_utils.js
    window.addEventListener('beforeunload', saveCurrentProgress); // Assumes saveCurrentProgress is in player_utils.js
    
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'hidden') {
            if(typeof saveCurrentProgress === 'function') saveCurrentProgress();
        }
    });

    const waitForVideo = setInterval(() => {
        if (dp && dp.video) { // dp from player_vars.js
            dp.video.addEventListener('pause', () => {if(typeof saveCurrentProgress === 'function') saveCurrentProgress()});
            let lastSave = 0;
            dp.video.addEventListener('timeupdate', function() {
                const now = Date.now();
                if (now - lastSave > 5000) { 
                    if(typeof saveCurrentProgress === 'function') saveCurrentProgress(); 
                    lastSave = now; 
                }
            });
            clearInterval(waitForVideo);
        }
    }, 200);
}

function playEpisode(index) {
    // Assumes currentEpisodes, dp, videoHasEnded, progressSaveInterval, currentVideoUrl, currentEpisodeIndex are global
    // Assumes saveCurrentProgress, showError, showToast, initPlayer, updateEpisodeInfo, updateButtonStates, renderEpisodes, saveToHistory are global or imported
    if (index < 0 || index >= currentEpisodes.length) {
        console.error(`无效的剧集索引: ${index}, 当前剧集数量: ${currentEpisodes.length}`);
        if(typeof showToast === 'function') showToast(`无效的剧集索引: ${index + 1}，当前剧集总数: ${currentEpisodes.length}`);
        return;
    }
    if (dp && dp.video && !dp.video.paused && !videoHasEnded) saveCurrentProgress();
    if (progressSaveInterval) { clearInterval(progressSaveInterval); progressSaveInterval = null; }
    
    document.getElementById('error').style.display = 'none';
    const loadingContainer = document.getElementById('loading');
    if (loadingContainer) {
        loadingContainer.style.display = 'flex';
        loadingContainer.innerHTML = `<div class="loading-spinner"></div>`; // Only spinner
    }
    
    const urlToPlay = currentEpisodes[index]; // Renamed to avoid conflict
    currentVideoUrl = urlToPlay; currentEpisodeIndex = index; videoHasEnded = false;
    
    const currentUrlParams = new URL(window.location.href);
    const sourceName = currentUrlParams.searchParams.get('source') || ''; 
    const currentSourceCode = currentUrlParams.searchParams.get('source_code') || ''; 
    
    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('index', index); newUrl.searchParams.set('url', urlToPlay);
    if (sourceName) newUrl.searchParams.set('source', sourceName);
    if (currentSourceCode) newUrl.searchParams.set('source_code', currentSourceCode);
    const referrerParam = currentUrlParams.searchParams.get('referrer'); 
    if (referrerParam) newUrl.searchParams.set('referrer', referrerParam);
    window.history.replaceState({}, '', newUrl);

    if (dp && typeof dp.destroy === 'function') { dp.destroy(); dp = null; }
    if (currentHls && typeof currentHls.destroy === 'function') { currentHls.destroy(); currentHls = null; }
    
    if(typeof initPlayer === 'function') initPlayer(urlToPlay, currentSourceCode);
    
    if(typeof updateEpisodeInfo === 'function') updateEpisodeInfo();
    if(typeof updateButtonStates === 'function') updateButtonStates();
    if(typeof renderEpisodes === 'function') renderEpisodes();
    userClickedPosition = null; // from player_vars.js
    setTimeout(() => { if(typeof saveToHistory === 'function') saveToHistory(); }, 3000);
}

function playPreviousEpisode() {
    // Assumes currentEpisodeIndex is global
    // Assumes playEpisode is global or imported
    if (currentEpisodeIndex > 0) playEpisode(currentEpisodeIndex - 1);
}

function playNextEpisode() {
    // Assumes currentEpisodeIndex, currentEpisodes are global
    // Assumes playEpisode is global or imported
    if (currentEpisodeIndex < currentEpisodes.length - 1) playEpisode(currentEpisodeIndex + 1);
}

function copyLinks() {
    // Assumes showToast is global or imported
    const urlParams = new URLSearchParams(window.location.search);
    const linkUrl = urlParams.get('url') || '';
    if (linkUrl !== '') {
        navigator.clipboard.writeText(linkUrl)
            .then(() => { if(typeof showToast === 'function') showToast('播放链接已复制', 'success'); })
            .catch(err => { if(typeof showToast === 'function') showToast('复制失败，请检查浏览器权限', 'error'); });
    }
}

function toggleEpisodeOrder() {
    // Assumes episodesReversed is global
    // Assumes renderEpisodes, updateOrderButton are global or imported
    episodesReversed = !episodesReversed;
    localStorage.setItem('episodesReversed', episodesReversed);
    if(typeof renderEpisodes === 'function') renderEpisodes();
    if(typeof updateOrderButton === 'function') updateOrderButton();
}

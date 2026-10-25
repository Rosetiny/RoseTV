
let playerLoadGeneration = 0;
function createRosePlayer(options) {
    const listeners = [], restore = [];
    for (const target of [document, window, options.container]) {
        const add = target.addEventListener;
        target.addEventListener = function(type, listener, options) {
            listeners.push([target, type, listener, typeof options === 'boolean' ? options : !!options?.capture]);
            return add.call(this, type, listener, options);
        };
        restore.push(() => { target.addEventListener = add; });
    }
    let player;
    try { player = new DPlayer(options); } finally { restore.forEach(reset => reset()); }
    const destroy = player.destroy.bind(player);
    let destroyed = false;
    player.destroy = () => {
        if (destroyed) return; destroyed = true;
        listeners.forEach(([target,type,listener,capture]) => target.removeEventListener(type,listener,capture)); listeners.length = 0;
        player.container.roseTouchCleanup?.();
        player.video.replaceChildren();
        destroy();
        player.video.removeAttribute('src'); player.video.load();
    };
    return player;
}
function playbackQualityControls(video, hls, rebuild = false) {
    let bar = document.getElementById('playbackQualityBar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'playbackQualityBar';
        bar.className = 'flex flex-wrap items-center gap-3 text-sm text-gray-400 py-2';
        document.getElementById('playerContainer').before(bar);
    }
    let label = bar.querySelector('span');
    if (!label || rebuild) {
        label = document.createElement('span');
        bar.replaceChildren(label);
        const select = document.createElement('select');
        select.id = 'playbackQuality';
        select.setAttribute('aria-label', '播放清晰度');
        select.className = 'bg-[#222] border border-[#444] rounded px-2 py-1';
        [{ height: 0 }, ...(hls?.levels || [])].forEach((level, index) => {
            const option = document.createElement('option');
            option.value = index - 1;
            option.textContent = index === 0 ? '自动清晰度' : level.height ? level.height + 'P' : '原始画质';
            select.append(option);
        });
        select.disabled = (hls?.levels.length || 0) < 2;
        select.hidden = select.disabled;
        select.onchange = () => { if (hls) hls.currentLevel = Number(select.value); };
        bar.append(select);
        const speed = document.createElement('select');
        speed.setAttribute('aria-label', '播放倍速');
        speed.className = select.className;
        [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3].forEach(rate => {
            const option = document.createElement('option');
            option.value = rate; option.textContent = rate + ' 倍速';
            option.selected = rate === video.playbackRate; speed.append(option);
        });
        speed.onchange = () => { video.playbackRate = Number(speed.value); };
        bar.append(speed);
        try {
            const lines = JSON.parse(sessionStorage.getItem('playbackLines') || 'null');
            const params = new URLSearchParams(location.search);
            if (lines?.title === params.get('title') && lines.sourceCode === params.get('source_code') && lines.groups.length > 1) {
                const source = document.createElement('select');
                source.setAttribute('aria-label', '切换播放线路');
                source.className = select.className;
                lines.groups.forEach((group, index) => {
                    const option = document.createElement('option');
                    option.value = index; option.textContent = group.name + (group.quality < 0 ? ' · 抢先/枪版' : '');
                    option.selected = group.episodes.some(episode => episode.url === currentVideoUrl);
                    source.append(option);
                });
                source.onchange = () => {
                    window.selectRosePlayback(lines.sourceCode, params.get('source') || '', lines.groups, Number(source.value));
                };
                bar.append(source);
            }
        } catch {}
        const switchSource = document.createElement('button');
        switchSource.textContent = (new URLSearchParams(location.search).get('source') || '全部来源') + ' · 换源';
        switchSource.onclick = () => window.openRoseSources();
        bar.append(switchSource);
    }
    label.textContent = video.videoHeight ? '实际分辨率：' + video.videoWidth + ' × ' + video.videoHeight : '清晰度将在解码后显示';
}
function initPlayer(videoUrl, sourceCode) {
    if (!videoUrl) return;
    const restoreParams=new URLSearchParams(location.search),restorePaused=restoreParams.get('resume')==='0',restoreRate=Number(restoreParams.get('rate'));
    if(restoreParams.has('resume')||restoreParams.has('rate')){const clean=new URL(location.href);clean.searchParams.delete('resume');clean.searchParams.delete('rate');history.replaceState({},'',clean);}
    const mp4 = /\.mp4(?:[?#]|$)/i.test(videoUrl);
    const bridge = window.ROSETV_BRIDGE;
    if (bridge?.key && /^https?:\/\//.test(videoUrl) && !videoUrl.startsWith(bridge.url + '/')) {
        videoUrl = bridge.mediaURL(videoUrl);
    }
    const generation = ++playerLoadGeneration;
    let dplayerErrorTimeout = null;
    let networkRecoveries = 0, mediaRecoveries = 0;
    let fallbackStarted = false;
    function stopWaiting(message) {
        if (generation !== playerLoadGeneration) return;
        clearTimeout(dplayerErrorTimeout);
        currentHls?.stopLoad();
        showError(message);
        if (!fallbackStarted) { fallbackStarted = true; window.roseTryNextSource?.(sourceCode).catch(() => {}); }
    }
    function armDeadline() {
        clearTimeout(dplayerErrorTimeout);
        dplayerErrorTimeout = setTimeout(() => {if(!dp?.video?.paused&&!window.roseBrowsing)stopWaiting('此源超过 8 秒没有播放进展，可换源或重试');}, 8000);
    }
    let hlsPlaybackStarted = false; 
    let errorDisplayedGlobal = false;

    hlsPlaybackStarted = false; errorDisplayedGlobal = false;
    document.getElementById('error').style.display = 'none';
    const loadingDivInit = document.getElementById('loading');
    if(loadingDivInit) {
        loadingDivInit.style.display = 'flex';
        loadingDivInit.innerHTML = `<div class="loading-spinner"></div>`; 
    }

    let startPosition = Number(new URLSearchParams(location.search).get('position')) || 0;
    if (!startPosition) try { startPosition = JSON.parse(localStorage.getItem('videoProgress_' + currentVideoUrl) || '{}').position || 0; } catch {}
    const hlsConfig = {
        debug: false,
        startPosition,
        enableWorker: true, lowLatencyMode: false, backBufferLength: 20, frontBufferFlushThreshold: 45,
        maxBufferLength: 20, maxMaxBufferLength: 40, maxBufferSize: 16 * 1000 * 1000,
        maxBufferHole: 0.5, fragLoadingMaxRetry: 2, fragLoadingMaxRetryTimeout: 4000,
        fragLoadingTimeOut: 10000, manifestLoadingTimeOut: 10000, levelLoadingTimeOut: 10000,
        fragLoadingRetryDelay: 500, manifestLoadingMaxRetry: 1, manifestLoadingRetryDelay: 500,
        levelLoadingMaxRetry: 1, levelLoadingRetryDelay: 500, startLevel: -1,
        abrEwmaDefaultEstimate: 500000, abrBandWidthFactor: 0.95, abrBandWidthUpFactor: 0.7,
        abrMaxWithRealBitrate: true, stretchShortVideoTrack: true, appendErrorMaxRetry: 5,
        liveSyncDurationCount: 3, liveDurationInfinity: false
    };
    
    dp = createRosePlayer({
        container: document.getElementById('player'),
        autoplay: !restorePaused, theme: '#dedede', preload: 'auto', loop: false, lang: 'zh-cn', 
        hotkey: true, mutex: true, volume: 0.7, screenshot: true, 
        preventClickToggle: false, airplay: true, chromecast: true,
        contextmenu: [
            { text: '关于 RoseTV', link: 'https://github.com/KeyRotate/RoseTV-App' },
            { text: '问题反馈', click: () => window.open('about.html', '_blank') }
        ],
        video: {
            url: videoUrl,
            type: mp4 ? 'normal' : 'hls',
            pic: '',
            customType: {
                hls: function(videoElement, playerInstance) { // Corrected parameters for DPlayer customType
                    if (currentHls && currentHls.destroy) { 
                        try { currentHls.destroy(); } catch (e) { console.warn('销毁旧HLS实例出错:', e); }
                    }
                    const hls = new Hls(hlsConfig); 
                    currentHls = hls;
                    let errorCount = 0;
                    let bufferAppendErrorCount = 0;
                    
                    videoElement.addEventListener('playing', function() {
                        hlsPlaybackStarted = true; 
                        errorDisplayedGlobal = false;
                        document.getElementById('loading').style.display = 'none';
                        document.getElementById('error').style.display = 'none';
                        if (dplayerErrorTimeout) { clearTimeout(dplayerErrorTimeout); dplayerErrorTimeout = null; }
                    });
                    videoElement.addEventListener('timeupdate', function() { 
                        if (videoElement.currentTime > 1) {
                            document.getElementById('error').style.display = 'none';
                        } 
                    });

                    hls.loadSource(videoUrl);
                    hls.attachMedia(videoElement);
                    
                    const sourceElementForAirplay = document.createElement('source'); 
                    sourceElementForAirplay.src = videoUrl; 
                    videoElement.appendChild(sourceElementForAirplay); 
                    videoElement.disableRemotePlayback = false;
                    
                    playbackQualityControls(videoElement, hls, true);
                    videoElement.addEventListener('resize', () => playbackQualityControls(videoElement, hls));
                    videoElement.addEventListener('waiting', () => { if (!videoElement.paused) armDeadline(); });
                    videoElement.addEventListener('pause', () => clearTimeout(dplayerErrorTimeout));
                    hls.on(Hls.Events.MANIFEST_PARSED, function() {
                        armDeadline();
                        playbackQualityControls(videoElement, hls, true);
                        if (autoplayEnabled&&!restorePaused) {
                           videoElement.play().catch(() => { clearTimeout(dplayerErrorTimeout); document.getElementById('loading').style.display = 'none'; });
                        }
                    });
                    
                    hls.on(Hls.Events.ERROR, function(event, data) { 
                        console.log('HLS事件:', event, '数据:', data);
                        errorCount++;
                        if (data.details === 'bufferAppendError') {
                            bufferAppendErrorCount++;
                            console.warn(`bufferAppendError 发生 ${bufferAppendErrorCount} 次`);
                            if (hlsPlaybackStarted) {
                                console.log('视频已在播放中，忽略bufferAppendError');
                                return;
                            }
                            if (bufferAppendErrorCount === 3 && mediaRecoveries++ === 0) {
                                hls.recoverMediaError();
                            }
                        }
                        if (data.fatal) {
                            console.error('致命HLS错误:', data);
                            switch(data.type) {
                                case Hls.ErrorTypes.NETWORK_ERROR:
                                    if (networkRecoveries++ >= 1) { stopWaiting('此源网络不可用，请重试或换源'); return; }
                                    console.log("尝试恢复网络错误");
                                    hls.startLoad(); 
                                    break;
                                case Hls.ErrorTypes.MEDIA_ERROR:
                                    if (mediaRecoveries++ >= 1) { stopWaiting('此源解码失败，请换一个资源'); return; }
                                    console.log("尝试恢复媒体错误");
                                    hls.recoverMediaError(); 
                                    break;
                                default:
                                    if (errorCount > 3 && !errorDisplayedGlobal) {
                                        showError('视频加载失败，可能是格式不兼容或源不可用 (HLS error)');
                                    }
                                    break;
                            }
                        }
                    });
                    hls.on(Hls.Events.FRAG_LOADED, () => { document.getElementById('loading').style.display = 'none'; });
                    hls.on(Hls.Events.LEVEL_LOADED, () => { document.getElementById('loading').style.display = 'none'; });
                }
            } // Explicitly no comma after customType if it's the last property of video
        } // Explicitly no comma after video if it's the last property of DPlayer options
    });

    
    dp.on('loadedmetadata', function() {
        errorDisplayedGlobal = false;
        playbackQualityControls(dp.video, currentHls);
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'none';
        videoHasEnded = false;

        const urlParams = new URLSearchParams(window.location.search);
        const savedPosition = parseInt(urlParams.get('position') || '0');
        if (savedPosition > 0 && dp && dp.video && dp.video.duration > 0 && savedPosition < dp.video.duration - 2) {
            dp.seek(savedPosition); 
            if(typeof showPositionRestoreHint === 'function') showPositionRestoreHint(savedPosition);
        } else {
            try {
                const progressKey = 'videoProgress_' + currentVideoUrl;
                const progressStr = localStorage.getItem(progressKey);
                if (progressStr && dp && dp.video && dp.video.duration > 0) {
                    const progress = JSON.parse(progressStr);
                    if (progress && typeof progress.position === 'number' && progress.position > 10 && progress.position < dp.video.duration - 2) {
                        dp.seek(progress.position); 
                        if(typeof showPositionRestoreHint === 'function') showPositionRestoreHint(progress.position);
                    }
                }
            } catch (e) { /* ignore */ }
        }
        if (autoplayEnabled && !restorePaused && dp && dp.video && dp.video.paused) {
            console.log('[PlayerJS] loadedmetadata: Attempting dp.play() due to autoplayEnabled.');
            Promise.resolve(dp.play()).catch(e => {
                console.warn("Autoplay attempt on loadedmetadata failed. This might be due to browser policy requiring user interaction.", e);
            });
        }

        if(typeof setupProgressBarPreciseClicks === 'function') setupProgressBarPreciseClicks();
        setTimeout(saveToHistory, 3000);
        startProgressSaveInterval();
    });

    dp.on('error', function() { /* ... DPlayer error handling ... */ });
    setupLongPressSpeedControl();
    dp.on('seeking', function() { /* ... seeking logic ... */ });
    dp.on('seeked', function() { /* ... seeked logic ... */ });
    dp.on('ended', function() { if (autoplayEnabled && currentEpisodeIndex + 1 < currentEpisodes.length) playEpisode(currentEpisodeIndex + 1); });
    dp.on('timeupdate', function() { if (dp.video && dp.duration > 0 && isUserSeeking && dp.video.currentTime > dp.video.duration * 0.95) videoHasEnded = false; });
    dp.video.addEventListener('dblclick', () => dp.fullScreen.toggle());
    dp.on('play', () => queueMicrotask(() => window.refreshRoseIcons?.()));
    dp.on('pause', () => queueMicrotask(() => window.refreshRoseIcons?.()));
    dp.on('playing', () => {
        clearTimeout(dplayerErrorTimeout);
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'none';
    });
    dp.on('destroy', () => clearTimeout(dplayerErrorTimeout));
    dp.video.playbackRate = restoreRate>=.5&&restoreRate<=3?restoreRate:Number(localStorage.getItem('rosePlaybackRate'))||1;
    const rateVideo = dp.video;
    rateVideo.addEventListener('ratechange', () => { if (generation === playerLoadGeneration) localStorage.setItem('rosePlaybackRate', rateVideo.playbackRate); });
    function addCustomVideoViewSettings(playerInstance) {
        if (!playerInstance || !playerInstance.template || !playerInstance.template.settingBox) {
            console.warn('DPlayer instance or template not ready for custom settings.');
            return;
        }

        const originPanel = playerInstance.template.settingBox.querySelector('.dplayer-setting-origin-panel');
        if (!originPanel) {
            console.warn('DPlayer setting origin panel not found.');
            return;
        }

        const videoElement = playerInstance.video;
        let currentVideoMode = localStorage.getItem('dplayer-video-mode') || 'contain';
        let currentVideoOffsetY = localStorage.getItem('dplayer-video-offset-y') || '0%';
        let isInOffsetSubmenu = false; // State to track if offset submenu is active

        const applyVideoStyles = () => {
            videoElement.style.objectFit = currentVideoMode;
            videoElement.style.objectPosition = (currentVideoMode === 'cover') ? `50% calc(50% + ${currentVideoOffsetY})` : '50% 50%';
            videoElement.style.width = '100%';
            videoElement.style.height = '100%';
        };

        const videoModeSettingItems = [];
        const videoOffsetYSettingItems = [];
        let backButtonFromOffsetMenu;

        const createSettingItem = (label, actionOrMode, type, value = null) => {
            const item = document.createElement('div');
            item.classList.add('dplayer-setting-item');
            
            const labelSpan = document.createElement('span');
            labelSpan.classList.add('dplayer-label');
            labelSpan.textContent = label;
            item.appendChild(labelSpan);

            const toggleDiv = document.createElement('div');
            toggleDiv.classList.add('dplayer-toggle');
            item.appendChild(toggleDiv);

            switch (type) {
                case 'mode':
                    item.classList.add(`dplayer-setting-video-mode-${actionOrMode}`);
                    item.addEventListener('click', () => {
                        currentVideoMode = actionOrMode;
                        localStorage.setItem('dplayer-video-mode', currentVideoMode);
                        if (currentVideoMode !== 'cover') {
                            currentVideoOffsetY = '0%'; // Reset offset if not cover
                            localStorage.setItem('dplayer-video-offset-y', currentVideoOffsetY);
                        }
                        applyVideoStyles();
                        updateActiveStates();
                        if (playerInstance.setting && typeof playerInstance.setting.hide === 'function') {
                            playerInstance.setting.hide();
                        }
                    });
                    break;
                case 'mode-with-submenu': // For "画面裁剪"
                    item.classList.add(`dplayer-setting-video-mode-${actionOrMode}`);
                    item.addEventListener('click', () => {
                        currentVideoMode = actionOrMode; // Set mode to cover
                        localStorage.setItem('dplayer-video-mode', currentVideoMode);
                        applyVideoStyles(); // Apply style immediately
                        isInOffsetSubmenu = true;
                        updateActiveStates(); // This will now show submenu items
                    });
                    break;
                case 'offset':
                    item.classList.add('dplayer-setting-video-offset-y');
                    item.dataset.offsetValue = value;
                    item.addEventListener('click', () => {
                        currentVideoOffsetY = value;
                        localStorage.setItem('dplayer-video-offset-y', currentVideoOffsetY);
                        applyVideoStyles();
                        updateActiveStates();
                    });
                    break;
                case 'back':
                    item.classList.add('dplayer-setting-back-button');
                    item.addEventListener('click', () => {
                        isInOffsetSubmenu = false;
                        updateActiveStates();
                    });
                    toggleDiv.style.display = 'none'; 
                    labelSpan.innerHTML = `← ${label}`;
                    break;
            }
            return item;
        };
        const mainModeOptions = [
            { label: playerInstance.tran('默认模式') || '默认模式', mode: 'contain', type: 'mode' },
            { label: playerInstance.tran('画面裁剪') || '画面裁剪', mode: 'cover', type: 'mode-with-submenu' },
            { label: playerInstance.tran('画面拉伸') || '画面拉伸', mode: 'fill', type: 'mode' }
        ];

        mainModeOptions.forEach(opt => {
            const newItem = createSettingItem(opt.label, opt.mode, opt.type);
            originPanel.appendChild(newItem);
            videoModeSettingItems.push(newItem);
        });
        backButtonFromOffsetMenu = createSettingItem(playerInstance.tran('返回') || '返回', null, 'back');
        backButtonFromOffsetMenu.style.display = 'none';
        originPanel.appendChild(backButtonFromOffsetMenu);
        const offsetYLabel = createSettingItem(playerInstance.tran('垂直偏移') || '垂直偏移', null, 'offset-label');
        offsetYLabel.style.display = 'none';
        offsetYLabel.classList.add('dplayer-setting-offset-label'); // For specific styling
        offsetYLabel.querySelector('.dplayer-toggle').style.display = 'none';
        offsetYLabel.replaceWith(offsetYLabel.cloneNode(true)); // Break event listener
        originPanel.appendChild(offsetYLabel);
        videoOffsetYSettingItems.push(offsetYLabel);


        const offsets = [
            { label: '+50%', value: '50%' }, { label: '+40%', value: '40%' },
            { label: '+30%', value: '30%' }, { label: '+20%', value: '20%' },
            { label: '+10%', value: '10%' }, { label: '0%', value: '0%' },
            { label: '-10%', value: '-10%' }, { label: '-20%', value: '-20%' },
            { label: '-30%', value: '-30%' }, { label: '-40%', value: '-40%' },
            { label: '-50%', value: '-50%' }
        ];

        offsets.forEach(offset => {
            const newItem = createSettingItem(offset.label, null, 'offset', offset.value);
            newItem.style.display = 'none'; // Initially hidden, part of submenu
            originPanel.appendChild(newItem);
            videoOffsetYSettingItems.push(newItem);
        });
        
        function updateActiveStates() {
            if (isInOffsetSubmenu) {
                videoModeSettingItems.forEach(item => item.style.display = 'none');
                backButtonFromOffsetMenu.style.display = 'flex';
                videoOffsetYSettingItems.forEach(item => {
                    item.style.display = item.classList.contains('dplayer-setting-offset-label') ? 'block' : 'flex';
                    if (item.classList.contains('dplayer-setting-video-offset-y')) {
                        const itemOffsetValue = item.dataset.offsetValue;
                        const toggleDiv = item.querySelector('.dplayer-toggle');
                        if (itemOffsetValue === currentVideoOffsetY) {
                            item.classList.add('dplayer-setting-item-active');
                            if (toggleDiv) { toggleDiv.innerHTML = '✓'; toggleDiv.style.color = playerInstance.options.theme || '#fff'; }
                        } else {
                            item.classList.remove('dplayer-setting-item-active');
                            if (toggleDiv) toggleDiv.innerHTML = '';
                        }
                    }
                });
            } else {
                videoModeSettingItems.forEach(item => {
                    item.style.display = 'flex';
                    const itemMode = item.classList.contains('dplayer-setting-video-mode-contain') ? 'contain' :
                                     item.classList.contains('dplayer-setting-video-mode-cover') ? 'cover' : 
                                     item.classList.contains('dplayer-setting-video-mode-fill') ? 'fill' : null;
                    const toggleDiv = item.querySelector('.dplayer-toggle');
                    if (itemMode === currentVideoMode) {
                        item.classList.add('dplayer-setting-item-active');
                        if (toggleDiv) { toggleDiv.innerHTML = '✓'; toggleDiv.style.color = playerInstance.options.theme || '#fff'; }
                    } else {
                        item.classList.remove('dplayer-setting-item-active');
                        if (toggleDiv) toggleDiv.innerHTML = '';
                    }
                    if (itemMode === 'cover' && toggleDiv) {
                        toggleDiv.innerHTML = item.classList.contains('dplayer-setting-item-active') ? '✓ >' : '>';
                    }
                });
                backButtonFromOffsetMenu.style.display = 'none';
                videoOffsetYSettingItems.forEach(item => item.style.display = 'none');
            }
        }
        
        applyVideoStyles(); 
        updateActiveStates();

        const translations = {
            'zh-cn': { '默认模式': '默认模式', '画面裁剪': '画面裁剪', '画面拉伸': '画面拉伸', '垂直偏移': '垂直偏移', '返回': '返回' },
            'zh-tw': { '默认模式': '默認模式', '画面裁剪': '畫面裁剪', '画面拉伸': '畫面拉伸', '垂直偏移': '垂直偏移', '返回': '返回' }
        };
        const lang = playerInstance.options.lang;
        if (translations[lang]) {
            for (const key in translations[lang]) {
                if (typeof c !== 'undefined' && c[lang] && !c[lang][key]) {
                    c[lang][key] = translations[lang][key];
                }
            }
        }
    }

    dp.on('loadedmetadata', function() { 
        setTimeout(() => {
            addCustomVideoViewSettings(dp);
        }, 100); 
    });

    let actions = document.getElementById('recoveryActions');
    if (!actions) {
        actions = document.createElement('div');
        actions.id = 'recoveryActions';
        actions.className = 'flex flex-wrap gap-3 mt-4';
        document.getElementById('error').append(actions);
    }
    actions.replaceChildren();
    for (const [text, retry] of [['重试当前源', true], ['换一个资源', false]]) {
        const button = document.createElement('button');
        button.className = 'px-4 py-2 rounded bg-[#333] border border-[#555]';
        button.textContent = text;
        button.onclick = () => {
            if (retry) {
                clearTimeout(dplayerErrorTimeout);
                currentHls?.destroy();
                dp?.destroy();
                currentHls = null; dp = null;
                initPlayer(videoUrl, sourceCode);
            } else {
                window.openRoseSources();
            }
        };
        actions.append(button);
    }
    armDeadline();
    window.refreshRoseIcons?.();
    window.roseBindPlayerWindows?.(dp);
}

function filterAdsFromM3U8(m3u8Content, strictMode = false) {
    return m3u8Content || '';
}

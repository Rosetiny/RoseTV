let detailGeneration = 0, detailEpisodes = [];
window.cancelDetailLoad = () => { detailGeneration++; };

async function showDetails(id, title, sourceCode) {
    if (window.isPasswordProtected?.() && !window.isPasswordVerified?.()) { showPasswordModal(); return; }
    if (!id || !sourceCode) { showToast('资源信息不完整', 'warning'); return; }
    const generation = ++detailGeneration;
    const modal = document.getElementById('modal'), content = document.getElementById('modalContent');
    const heading = document.getElementById('modalTitle');
    currentEpisodes = []; detailEpisodes = [];
    heading.textContent = title || '视频详情';
    content.textContent = '正在加载详情，最多等待 6 秒…';
    modal.classList.remove('hidden');
    try {
        const source = sourceInfo(sourceCode);
        if (!source) throw new Error('该资源源已被移除');
        let video = getSearchVideo(sourceCode, id);
        if (!video?.vod_play_url) {
            const data = await executeApiRequest((source.detail || source.url) + API_CONFIG.detail.path + encodeURIComponent(id),
                { headers: API_CONFIG.detail.headers, timeoutSecs: 6 });
            video = data.list?.find(item => String(item.vod_id) === String(id));
        }
        if (generation !== detailGeneration || modal.classList.contains('hidden')) return;
        if (!video) throw new Error('这个源没有返回该视频的详情，请尝试其他源');
        const groups = parsePlaybackGroups(video);
        if (!groups.length) throw new Error('这个资源暂无有效播放地址，请尝试其他源');
        sessionStorage.setItem('playbackLines', JSON.stringify({ title: title || video.vod_name, year: video.vod_year, sourceCode, groups }));
        currentVideoTitle = title || video.vod_name || '未知视频';
        heading.textContent = currentVideoTitle + ' · ' + source.name;
        const quality = document.createElement('p');
        quality.className = 'text-sm text-gray-400 mb-3';
        quality.textContent = resourceQuality(video).label + ' · 播放器会显示实际分辨率';
        const controls = document.createElement('div');
        controls.className = 'flex flex-wrap items-center gap-2 mb-3';
        const select = document.createElement('select');
        select.setAttribute('aria-label', '选择播放线路');
        select.className = 'bg-[#222] border border-[#444] rounded-lg p-2';
        groups.forEach((group, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = group.name + (group.quality < 0 ? ' · 抢先/枪版' : group.direct ? ' · 直连' : '');
            select.append(option);
        });
        const order = searchButton('倒序排列', () => {
            toggleEpisodeOrder(sourceCode);
            order.textContent = episodesReversed ? '正序排列' : '倒序排列';
        });
        controls.append(select, order, searchButton('复制播放链接', copyLinks));
        const grid = document.createElement('div');
        grid.id = 'episodesGrid';
        grid.className = 'grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2';
        function chooseGroup() {
            detailEpisodes = groups[Number(select.value)].episodes;
            currentEpisodes = detailEpisodes.map(episode => episode.url);
            episodesReversed = false;
            order.textContent = '倒序排列';
            grid.replaceChildren(renderEpisodes(currentVideoTitle, sourceCode, detailEpisodes));
            const first = currentEpisodes[0], bridge = window.ROSETV_BRIDGE;
            if (bridge?.enabled && /\.m3u8(?:[?#]|$)/i.test(first)) {
                fetch(first.startsWith(bridge.url + '/') ? first : bridge.mediaURL(first), { cache: 'force-cache' }).catch(() => {});
            }
        }
        select.onchange = chooseGroup;
        chooseGroup();
        content.replaceChildren(quality, controls, grid);
    } catch (error) {
        if (generation !== detailGeneration || modal.classList.contains('hidden')) return;
        const message = document.createElement('p');
        message.className = 'text-gray-300 mb-4';
        message.textContent = error.message || '详情加载失败，请重试或切换其他源';
        content.replaceChildren(message, searchButton('重试', () => showDetails(id, title, sourceCode)));
    }
}

function renderEpisodes(title, sourceCode, episodes) {
    const fragment = document.createDocumentFragment();
    const ordered = episodesReversed ? [...episodes].reverse() : episodes;
    ordered.forEach(episode => {
        const realIndex = currentEpisodes.indexOf(episode.url);
        const button = searchButton(episode.name || '第 ' + (realIndex + 1) + ' 集',
            () => playVideo(episode.url, title, sourceCode, realIndex));
        button.id = 'episode-' + realIndex;
        button.classList.add('episode-btn', 'truncate');
        button.title = episode.name || button.textContent;
        fragment.append(button);
    });
    return fragment;
}
function toggleEpisodeOrder(sourceCode) {
    episodesReversed = !episodesReversed;
    document.getElementById('episodesGrid')?.replaceChildren(renderEpisodes(currentVideoTitle, sourceCode, detailEpisodes));
}
function copyLinks() {
    const urls = episodesReversed ? [...currentEpisodes].reverse() : currentEpisodes;
    navigator.clipboard.writeText(urls.join('\r\n')).then(() => showToast('播放链接已复制', 'success'))
        .catch(() => showToast('复制失败，请重试', 'error'));
}

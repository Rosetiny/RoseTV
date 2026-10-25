let searchGeneration = 0, searchRows = [], searchSources = [], searchQuery = '', searchBusy = false, searchQuality = 0;
window.cancelSearchLoad = () => { searchGeneration++; window.searchController?.abort(); searchBusy = false; searchSources.forEach(source => { source.loading = false; }); };

function getSearchVideo(source, id) {
    return searchRows.find(item => item.source_code === source && String(item.vod_id) === String(id))
        || window.homeVideos?.get(source + ':' + id);
}
function searchButton(text, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'px-3 py-2 rounded-lg bg-[#222] border border-[#444] text-sm hover:bg-[#333]';
    button.textContent = text;
    button.onclick = action;
    return button;
}
function renderSearchResults() {
    const results = document.getElementById('results');
    if (!results) return;
    const visible = searchRows.filter(item => resourceQuality(item).rank >= searchQuality)
        .sort((a, b) => (typeof roseSearchScore==='function'?roseSearchScore(b,searchQuery)-roseSearchScore(a,searchQuery):0)
            || (typeof roseSearchScore==='function'&&roseSearchScore(a,searchQuery)===4?Number(b.vod_year||0)-Number(a.vod_year||0):0)
            || resourceQuality(b).rank-resourceQuality(a).rank || a.source_ms-b.source_ms);
    const count = document.getElementById('searchResultsCount');
    if (count) count.textContent = visible.length;
    const fragment = document.createDocumentFragment();
    const toolbar = document.createElement('div');
    toolbar.className = 'col-span-full flex flex-wrap items-center gap-2 mb-3';
    const status = document.createElement('span');
    status.id = 'searchStatus';
    status.setAttribute('role', 'status');
    status.className = 'text-sm text-gray-400 mr-auto';
    const done = searchSources.filter(source => !source.loading).length;
    status.textContent = searchBusy ? '已返回 ' + done + '/' + searchSources.length + ' 个源 · 结果可直接点击'
        : '显示 ' + visible.length + ' / ' + searchRows.length + ' 条 · 优先匹配片名，同名按年份区分';
    toolbar.append(status);
    const quality = document.createElement('select');
    quality.id = 'searchQuality';
    quality.setAttribute('aria-label', '按资源标注筛选清晰度');
    quality.className = 'bg-[#222] border border-[#444] rounded-lg px-2 py-2 text-sm';
    [[0, '优先清晰版'], [-1, '全部版本（含抢先）'], [720, '标注 720P 及以上'], [1080, '标注 1080P 及以上'], [2160, '标注 4K']].forEach(([value, text]) => {
        const option = document.createElement('option');
        option.value = value; option.textContent = text; option.selected = value === searchQuality;
        quality.append(option);
    });
    quality.onchange = () => { searchQuality = Number(quality.value); renderSearchResults(); };
    toolbar.append(quality);
    if (searchBusy) toolbar.append(searchButton('停止等待', () => {
        window.cancelSearchLoad();
        searchSources.forEach(source => { if (source.loading) source.error = '已停止等待'; source.loading = false; });
        renderSearchResults();
    }));
    fragment.append(toolbar);
    const sourceStatus = document.createElement('div');
    sourceStatus.id = 'sourceStatus';
    sourceStatus.className = 'col-span-full text-xs text-gray-400 mb-3';
    sourceStatus.textContent = searchSources.map(source => source.name + '：' + (source.loading ? '搜索中'
        : source.error || (source.count || 0) + ' 条 / ' + (source.ms / 1000).toFixed(1) + ' 秒')).join('　');
    fragment.append(sourceStatus);
    if (!visible.length) {
        const empty = document.createElement('p');
        empty.className = 'col-span-full text-center text-gray-400 py-8';
        empty.textContent = searchBusy ? '正在获取首批结果，可继续使用其他按钮…' : '没有匹配的资源，可更换关键词或清晰度筛选。';
        fragment.append(empty);
    }
    visible.forEach(item => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'rose-search-card';
        card.onclick = async () => {card.disabled=true;card.setAttribute('aria-busy','true');try{if(typeof roseOpenVideo==='function')await roseOpenVideo({...item,roseAllowEarly:searchQuality<0});else await showDetails(String(item.vod_id),item.vod_name||'未知视频',item.source_code);}finally{card.disabled=false;card.removeAttribute('aria-busy');}};
        const content = document.createElement('div');
        content.className = 'flex h-full';
        if (/^https?:\/\//.test(item.vod_pic || '')) {
            const image = document.createElement('img');
            image.src = item.vod_pic; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
            image.className = 'object-cover flex-shrink-0';
            image.style.cssText = 'width:80px;height:120px';
            image.onerror = () => image.remove();
            content.append(image);
        }
        const info = document.createElement('div');
        info.className = 'p-3 min-w-0';
        [item.vod_name || '未知视频', resourceQuality(item).label,
            [item.vod_year, item.type_name, item.vod_remarks].filter(Boolean).join(' · '),
            item.source_name + ' · ' + (item.source_ms / 1000).toFixed(1) + ' 秒'].forEach((text, index) => {
            const line = document.createElement(index === 0 ? 'h3' : 'p');
            line.className = index === 0 ? 'font-semibold mb-2 break-words' : 'text-xs text-gray-400 mb-1';
            line.textContent = text; info.append(line);
        });
        content.append(info); card.append(content); fragment.append(card);
    });
    if (!searchBusy && searchSources.some(source => source.page < source.pages || source.error)) {
        const more = searchButton('加载下一页 / 重试未响应源', () => loadSearchPages(searchGeneration));
        more.id = 'loadMoreResults'; more.classList.add('col-span-full'); fragment.append(more);
    }
    results.replaceChildren(fragment);
}
async function loadSearchPages(generation) {
    if (searchBusy) return;
    window.searchController?.abort();const controller=window.searchController=new AbortController();
    const sources = searchSources.filter(source => source.page < source.pages || source.error);
    searchBusy = true;
    sources.forEach(source => { source.loading = true; source.error = ''; });
    renderSearchResults();
    let cursor = 0;
    // Two requests at a time; pagination is explicit instead of scanning every page.
    async function worker() {
        while (cursor < sources.length && generation === searchGeneration) {
            const source = sources[cursor++], started = Date.now();
            try {
                const page = source.page + 1;
                const url = source.url + API_CONFIG.search.pagePath.replace('{query}', encodeURIComponent(searchQuery)).replace('{page}', page);
                const data = await executeApiRequest(url, { headers: API_CONFIG.search.headers, timeoutSecs: 8,signal:controller.signal });
                if (generation !== searchGeneration) return;
                if (!Array.isArray(data.list)) throw new Error('源返回的数据格式不正确');
                source.page = page; source.pages = Math.max(page, Number(data.pagecount) || 1); source.ms = Date.now() - started;
                const banned = /伦理片|福利|色情|里番|萝莉|无码|SWAG/i;
                data.list.forEach(item => {
                    if (isShortDrama(item)) return;
                    if (localStorage.getItem('yellowFilterEnabled') === 'true' && banned.test(item.type_name || '')) return;
                    if (!searchRows.some(row => row.source_code === source.id && String(row.vod_id) === String(item.vod_id))) searchRows.push({ ...item,
                        source_code: source.id, source_name: source.name, source_ms: source.ms, api_url: source.url });
                });
                source.count = searchRows.filter(item => item.source_code === source.id).length;
            } catch (error) {
                if (generation !== searchGeneration) return;
                source.error = error.message || '暂不可用'; source.ms = Date.now() - started;
            } finally {
                if (generation === searchGeneration) { source.loading = false; renderSearchResults(); }
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(2, sources.length) }, worker));
    if (generation === searchGeneration) { searchBusy = false; renderSearchResults(); }
}
async function search() {
    if (window.isPasswordProtected?.() && !window.isPasswordVerified?.()) { showPasswordModal(); return; }
    const query = document.getElementById('searchInput').value.trim();
    if (!query) { showToast('请输入搜索内容', 'info'); return; }
    if (!selectedAPIs.length) { showToast('请至少选择一个资源源', 'warning'); return; }
    if (query === searchQuery && searchBusy) return;
    const generation = ++searchGeneration;
    window.searchController?.abort();
    searchQuery = query; searchRows = []; searchBusy = false;
    searchSources = selectedAPIs.map(id => {
        const api = sourceInfo(id);
        return api && { ...api, id, page: 0, pages: 1, count: 0, ms: 0, loading: true, error: '' };
    }).filter(Boolean);
    if (typeof saveSearchHistory === 'function') saveSearchHistory(query);
    sessionStorage.setItem('lastSearchQuery', query); sessionStorage.setItem('lastPageView', 'searchResults');
    document.getElementById('resultsArea')?.classList.remove('hidden');
    hideLoading();
    await loadSearchPages(generation);
}

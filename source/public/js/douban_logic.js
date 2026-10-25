console.log('douban_logic.js loaded');

// Fisher-Yates (aka Knuth) Shuffle
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

// Helper function for caching Douban API data
async function fetchAndCacheDoubanData(cacheKey, fetchFn, ...fetchArgs) {
    try {
        const cachedData = sessionStorage.getItem(cacheKey);
        if (cachedData) {
            console.log("豆瓣首页：从缓存加载", cacheKey);
            // Ensure the loading overlay/message for the specific section is cleared if data is from cache
            // This might need to be handled where renderCategoryGridCards is called or before it.
            return JSON.parse(cachedData);
        }
    } catch (e) {
        console.error("豆瓣首页：读取缓存失败", cacheKey, e);
        sessionStorage.removeItem(cacheKey); // Remove corrupted cache entry
    }

    // Show loading specific to this fetch, if not already handled by caller
    // console.log("豆瓣首页：从API获取", cacheKey);
    const data = await fetchFn(...fetchArgs); // Call the original fetch function

    if (data && data.subjects) { // Only cache successful responses with data
        try {
            sessionStorage.setItem(cacheKey, JSON.stringify(data));
            console.log("豆瓣首页：已缓存", cacheKey);
        } catch (e) {
            console.error("豆瓣首页：写入缓存失败", cacheKey, e);
            // Consider clearing some old cache items if storage is full (e.g., LRU strategy)
            // For now, just log the error. A more robust solution might involve checking e.name === 'QuotaExceededError'
        }
    }
    return data;
}

// Global state variables related to Douban functionality
window.defaultMovieTags = ['热门', '最新', '经典', '豆瓣高分', '冷门佳片', '华语', '欧美', '韩国', '日本', '动作', '喜剧', '爱情', '科幻', '悬疑', '恐怖', '治愈'];
window.defaultTvTags = ['热门', '美剧', '英剧', '韩剧', '日剧', '国产剧', '港剧', '日本动画', '综艺', '纪录片'];

window.movieTags = [];
window.tvTags = [];

const movieChartNames = {
    'Top250电影': { tag: '豆瓣高分', sort: 'rank' },
    '正在热映': { tag: '热门', sort: 'recommend' },
    '即将上映': { tag: '最新', sort: 'time' },
    '新片榜': { tag: '最新', sort: 'recommend' },
    '口碑榜': { tag: '豆瓣高分', sort: 'recommend' },
    '近期高分电影': { tag: '豆瓣高分', sort: 'time' },
    '经典动作大片': { tag: '动作', sort: 'rank' },
    '热门科幻电影': { tag: '科幻', sort: 'recommend' },
    '冷门佳片精选': { tag: '冷门佳片', sort: 'rank' },
    '最新华语电影': { tag: '华语', sort: 'time' }
};

const tvChartNames = {
    '热门剧集综合榜': { tag: '热门', sort: 'rank' },
    '高分热门美剧': { tag: '美剧', sort: 'rank' },
    '近期日剧新作': { tag: '日剧', sort: 'time' },
    '经典纪录片': { tag: '纪录片', sort: 'rank' },
    '国产剧集精选': { tag: '国产剧', sort: 'recommend' },
    '高分日本动画': { tag: '日本动画', sort: 'rank'}
};

window.doubanMovieTvCurrentSwitch = 'movie'; // This might be primarily for search page filters now
window.doubanCurrentTag = '热门'; // Represents the currently active tag for category view

// New structure for homepage top navigation tags
window.homepageTopNavTags = []; // To be populated in initDouban or a dedicated function

// For Category View
window.currentCategoryViewTag = '';
window.currentCategoryViewType = '';
window.currentCategoryPageStart = 0;
window.categoryItemsPerPage = 20; // Adjusted to 20 as per user observation for better infinite scroll
window.isLoadingCategoryItems = false;
window.noMoreCategoryItems = false;
window.currentCategorySourceConfig = null; // To store source config for category view

// For Home Page Waterfall
window.homePageActiveTags = []; 
window.homePageCurrentTagIndex = 0;
window.homePageItemsPerTag = 12;
window.homePageTagsPerBatch = 2; 
window.isLoadingHomePageItems = false;
window.noMoreHomePageTags = false;

// --- Old Douban Search Filter Logic (for dropdowns) is now removed ---
// The new button-based filters on the search page are handled by douban_filters.js


function loadUserTags() {
    try {
        const savedMovieTags = localStorage.getItem('userMovieTags');
        window.movieTags = savedMovieTags ? JSON.parse(savedMovieTags) : [...window.defaultMovieTags];
        const savedTvTags = localStorage.getItem('userTvTags');
        window.tvTags = savedTvTags ? JSON.parse(savedTvTags) : [...window.defaultTvTags];
    } catch (e) {
        console.error('加载标签失败：', e);
        window.movieTags = [...window.defaultMovieTags]; 
        window.tvTags = [...window.defaultTvTags];
    }
}

function saveUserTags() {
    try {
        localStorage.setItem('userMovieTags', JSON.stringify(window.movieTags));
        localStorage.setItem('userTvTags', JSON.stringify(window.tvTags));
    } catch (e) { 
        console.error('保存标签失败：', e); 
        if (typeof showToast === 'function') showToast('保存标签失败', 'error'); 
    }
}

window.homeVideos = new Map();
let homeGeneration = 0, homePrefetchBusy = false;
let homeView = { kind: 'home', page: 1 };
const homeTrail = [];
function roseBrowseLimit() {
    const width = document.getElementById('douban-recommendations-container')?.clientWidth || window.innerWidth || 1024;
    return 2 * Math.min(12, window.innerWidth <= 600 ? 3 : Math.max(2, Math.floor((width + 17) / 177)));
}
let homeResizeTimer;
window.addEventListener?.('resize', () => {
    clearTimeout(homeResizeTimer);
    homeResizeTimer = setTimeout(() => {
        if (document.getElementById('page-home')?.offsetParent !== null && homeView.limit !== roseBrowseLimit()) showRoseCatalog(homeView.kind, 1, false);
    }, 300);
});

function initRoseBrowseStyle() {
    if (document.getElementById('roseBrowseStyle')) return;
    const style = document.createElement('style');
    style.id = 'roseBrowseStyle';
    style.textContent = `
      #page-home{max-width:1480px;padding-top:20px}#page-home>header,#home-content-area>div:has(#douban-tags){display:none}
      .rose-nav{display:flex;align-items:center;gap:8px;padding:4px 0 20px;border-bottom:1px solid #263244;margin-bottom:24px;flex-wrap:wrap}
      .rose-brand{font-size:23px;font-weight:750;letter-spacing:-.7px;margin-right:20px;background:linear-gradient(110deg,#25c7e9,#c779d0);background-clip:text;color:transparent}
      .rose-nav button,.rose-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid transparent;border-radius:9px;padding:9px 12px;color:#a9b6cc;background:transparent;font-size:14px;transition:background .15s,color .15s}
      .rose-nav button:hover,.rose-btn:hover{background:#1e2d44;color:#fff}.rose-nav button.active{color:#69c8ff;background:#142d46}
      .rose-nav form{display:flex;flex:1;min-width:180px;max-width:420px;margin-left:auto;background:#101b2d;border:1px solid #2b3a50;border-radius:10px}
      .rose-nav input{background:transparent;color:#e5edf9;min-width:0;flex:1;padding:10px 12px;outline:none}.rose-nav form:focus-within{border-color:#55b8ed}
      .rose-section{margin:25px 0 34px}.rose-section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:15px;gap:12px}
      .rose-section-head h2{font-size:20px;font-weight:650;letter-spacing:.1px}.rose-section-head small{font-size:12px;color:#71839f;margin-left:10px;font-weight:400}
      .rose-more{color:#8abfe2!important;border-color:#2b3f58!important;background:#122338!important;padding:6px 11px!important}
      .rose-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:23px 17px}
      .rose-poster{display:flex;flex-direction:column;min-width:0;text-align:left;cursor:pointer;border-radius:10px;outline-offset:4px}
      .rose-cover{position:relative;aspect-ratio:2/3;overflow:hidden;border-radius:9px;background:#15243b;border:1px solid #27354a;box-shadow:0 4px 18px #0002}
      .rose-cover img{width:100%;height:100%;object-fit:cover;transition:transform .2s}.rose-poster:hover img{transform:scale(1.025)}
      .rose-rating{position:absolute;left:7px;bottom:7px;display:flex;align-items:center;gap:4px;font-size:12px;color:#ffe0a0;background:#101827dd;padding:3px 6px;border-radius:5px}
      .rose-status{position:absolute;right:7px;top:7px;max-width:90%;font-size:11px;color:#e3eef9;background:#111d32db;padding:3px 6px;border-radius:5px}
      .rose-poster h3{font-size:14px;line-height:1.5;color:#e4ebf6;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:9px 0 3px}
      .rose-poster p{font-size:12px;line-height:1.5;color:#8294b0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .rose-empty{color:#91a4bf;padding:35px 0}.rose-pages{display:flex;align-items:center;justify-content:center;gap:14px;padding:24px 0;color:#91a4bf}
      .rose-pages button{border-color:#2b3a50;background:#142238}.rose-pages button:disabled{opacity:.35;cursor:default}
      #bottomNav{background:#101a2aeb!important;border-color:#27364b!important;backdrop-filter:blur(16px)}#bottomNav .nav-item{color:#7e91ad;border-radius:12px;min-width:66px;gap:3px}
      #bottomNav .nav-item.active{color:#68c6f0;background:#162a43}#bottomNav svg{width:22px;height:22px;margin-bottom:1px}
      #modal>div{border-radius:16px;border-color:#30425c;background:#101b2c}#modal{backdrop-filter:blur(8px)}
      #douban-filter-items-grid,#category-items-grid{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(160px,1fr))!important;gap:23px 17px!important}
      @media(max-width:600px){.rose-grid,#douban-filter-items-grid,#category-items-grid{grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:16px 10px!important}.rose-nav{gap:2px}.rose-brand{margin-right:4px}.rose-nav form{order:2;max-width:none;flex-basis:100%;margin:10px 0 0}.rose-status{font-size:10px}.rose-poster h3{font-size:12px}}
    `;
    document.head.append(style);
    if (!window.roseFilterPosterDelegate) {
        window.roseFilterPosterDelegate = true;
        document.addEventListener('click', event => {
            const card = event.target.closest('[data-douban-title]');
            if (card) fillAndSearchWithDouban(card.dataset.doubanTitle);
        });
    }
}

function rosePoster(item, open) {
    const card = document.createElement('button');
    card.type = 'button'; card.className = 'rose-poster';
    const title = String(item.vod_name || '未知影片');
    card.title = title;
    if (open) card.onclick = open;
    const cover = document.createElement('div'); cover.className = 'rose-cover';
    const empty = document.createElement('div'); empty.className = 'rose-cover-fallback';
    const caption = document.createElement('span'); caption.textContent = title;
    const hint = document.createElement('small'); hint.textContent = '暂无海报';
    empty.append(window.roseIcon('film',28),caption,hint);
    const image = document.createElement('img');
    const original = /(?:movie|tv)_default|default_(?:large|small)|nopic/i.test(item.vod_pic || '') ? '' : item.vod_pic || '';
    if(original.startsWith('http'))hint.textContent='加载海报…';
    image.alt = title; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
    if (original.startsWith('http')) {
        if(window.roseLoadPoster)window.roseLoadPoster(image,original);else image.src = original;
        if (item.source_code === 'site'&&!window.roseLoadPoster) {
            image.srcset = original + '&size=256 256w, ' + original + '&size=384 384w';
            image.sizes = '(max-width:600px) 30vw, (max-width:1100px) 22vw, 185px';
        }
    }
    let failed = false;
    image.onerror = () => {
        if (!failed && item.original_pic && original !== item.original_pic) {
            failed = true; image.srcset = ''; if(window.roseLoadPoster)window.roseLoadPoster(image,item.original_pic);else image.src = item.original_pic; return;
        }
        image.removeAttribute('src'); image.removeAttribute('srcset');
        image.hidden = true; empty.hidden = false; image.alt = title + ' · 封面暂不可用';
        hint.textContent='海报暂不可用';
        window.roseRecoverPoster?.(item,image);
    };
    image.onload = () => { image.hidden=false;empty.hidden=true;if (image.naturalWidth < 160) image.style.objectFit = 'contain'; };
    if(!original){image.hidden=true;queueMicrotask(()=>window.roseRecoverPoster?.(item,image));}
    cover.append(image,empty);
    if (Number(item.vod_douban_score) > 0) {
        const rating = document.createElement('span'); rating.className = 'rose-rating';
        rating.append(window.roseIcon('star', 12), document.createTextNode(String(item.vod_douban_score)));
        cover.append(rating);
    }
    if (item.vod_remarks) {
        const status = document.createElement('span'); status.className = 'rose-status'; status.textContent = item.vod_remarks;
        cover.append(status);
    }
    const heading = document.createElement('h3'); heading.textContent = title;
    const note = document.createElement('p'); note.textContent = [item.vod_year, item.vod_area || item.type_name].filter(Boolean).join(' / ');
    card.append(cover, heading, note);
    return card;
}

function roseBrowseButton(text, icon, action) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'rose-btn';
    if (icon) button.append(window.roseIcon(icon, 17));
    if (text) button.append(document.createTextNode(text));
    button.onclick = action; return button;
}

function renderRoseBrowseNav() {
    let nav = document.getElementById('roseBrowseNav');
    if (!nav) { nav = document.createElement('nav'); nav.id = 'roseBrowseNav'; nav.className = 'rose-nav'; document.getElementById('page-home').prepend(nav); }
    nav.replaceChildren();
    const brand = document.createElement('span'); brand.className = 'rose-brand'; brand.textContent = 'RoseTV'; nav.append(brand);
    for (const [kind, title, icon] of [['home', '推荐', 'home'], ['mv', '电影', 'film'], ['tv', '剧集', 'series'], ['ac', '动漫', 'sparkles']]) {
        const button = roseBrowseButton(title, icon, () => showRoseCatalog(kind, 1));
        button.classList.toggle('active', homeView.kind === kind); nav.append(button);
    }
    const form = document.createElement('form');
    const input = document.createElement('input'); input.placeholder = '搜索影片、剧集'; input.setAttribute('aria-label', '首页搜索');
    const searchButton = roseBrowseButton('', 'search', () => {}); searchButton.type = 'submit'; searchButton.title = '搜索';
    form.append(input, searchButton);
    form.onsubmit = event => {
        event.preventDefault(); if (!input.value.trim()) return;
        document.getElementById('searchInput').value = input.value.trim(); navigateToTab('search'); search();
    };
    nav.append(form);
    for (const [page, label, icon] of [['history', '历史', 'history'], ['settings', '设置', 'settings']]) {
        const button = roseBrowseButton('', icon, () => navigateToTab(page)); button.title = label; button.setAttribute('aria-label', label); nav.append(button);
    }
}

window.popRoseCatalog = () => {
    const previous = homeTrail.pop();
    if (previous) { homeView = previous; showRoseCatalog(previous.kind, previous.page, false); return true; }
    if (homeView.kind !== 'home') { showRoseCatalog('home', 1, false); return true; }
    return false;
};

async function showRoseCatalog(kind = 'home', page = 1, remember = true) {
    const limit = roseBrowseLimit();
    const cursors = homeView.kind === kind && homeView.limit === limit ? homeView.cursors || [0] : [0];
    const cursor = cursors[page - 1] ?? (page - 1) * limit;
    if (remember && (homeView.kind !== kind || homeView.page !== page)) {
        homeTrail.push({ ...homeView }); if (homeTrail.length > 12) homeTrail.shift();
    }
    homeView = { kind, page, limit, cursors };
    sessionStorage.setItem('roseCatalogState', JSON.stringify(homeView));
    const generation = ++homeGeneration;
    const container = document.getElementById('douban-recommendations-container');
    if (!container) return;
    initRoseBrowseStyle(); renderRoseBrowseNav();
    container.textContent = '正在加载影片…';
    window.isLoadingHomePageItems = true;
    try {
        const bridge = await window.bridgeReady;
        if (window.roseRefreshHome || generation !== homeGeneration) return;
        if (!bridge?.enabled) throw new Error('请从桌面图标启动 RoseTV');
        if (kind !== 'home' && !bridge.site) throw new Error('网站会话暂不可用，请使用搜索或稍后重试');
        const data = await executeApiRequest(bridge.url + (kind === 'home' ? '/home?limit=' + limit : '/catalog?kind=' + kind + '&page=' + page + '&limit=' + limit + '&cursor=' + cursor), { timeoutSecs: 6 });
        if (generation !== homeGeneration) return;
        if (Number.isInteger(data.nextCursor)) cursors[page] = data.nextCursor;
        sessionStorage.setItem('roseCatalogState', JSON.stringify(homeView));
        const groups = kind === 'home' ? data.groups || [] : [data];
        container.replaceChildren(); window.homeVideos.clear();
        for (const group of groups) {
            const section = document.createElement('section'); section.className = 'rose-section';
            const head = document.createElement('div'); head.className = 'rose-section-head';
            const heading = document.createElement('h2'); heading.textContent = group.title;
            head.append(heading);
            if (kind === 'home' && group.kind) {
                const more = roseBrowseButton('更多', 'next', () => showRoseCatalog(group.kind, 1)); more.classList.add('rose-more'); head.append(more);
            } else if (kind !== 'home') {
                head.append(roseBrowseButton('返回推荐', 'back', () => window.roseGoBack()));
            }
            const grid = document.createElement('div'); grid.className = 'rose-grid';
            for (const item of (group.list || []).slice(0, limit)) {
                const key = item.source_code + ':' + item.vod_id;
                window.homeVideos.set(key, item);
                const card = rosePoster(item, () => showDetails(String(item.vod_id), item.vod_name, item.source_code));
                let timer;
                card.onpointerenter = card.onfocus = () => {
                    timer = setTimeout(async () => {
                        if (homePrefetchBusy || item.vod_play_url || item.source_code !== 'site') return;
                        homePrefetchBusy = true;
                        try {
                            const response = await executeApiRequest(bridge.url + API_CONFIG.detail.path + encodeURIComponent(item.vod_id), { timeoutSecs: 6 });
                            if (response.list?.[0] && generation === homeGeneration) window.homeVideos.set(key, { ...item, ...response.list[0] });
                        } catch {} finally { homePrefetchBusy = false; }
                    }, 220);
                };
                card.onpointerleave = card.onblur = () => clearTimeout(timer); grid.append(card);
            }
            if (!group.list?.length) { const empty = document.createElement('p'); empty.className = 'rose-empty'; empty.textContent = '这一页暂无可播放影片，可返回上一页。'; grid.append(empty); }
            section.append(head, grid); container.append(section);
        }
        if (kind !== 'home') {
            const pages = document.createElement('div'); pages.className = 'rose-pages';
            const previous = roseBrowseButton('上一页', 'back', () => showRoseCatalog(kind, page - 1)); previous.disabled = page <= 1;
            const label = document.createElement('span'); label.textContent = '第 ' + page + ' 页';
            const next = roseBrowseButton('下一页', 'next', () => showRoseCatalog(kind, page + 1)); next.disabled = data.hasMore === false || page >= 100;
            pages.append(previous, label, next); container.append(pages);
        }
        window.scrollTo(0, 0);
        window.noMoreHomePageTags = true;
        window.refreshRoseIcons?.();
    } catch (error) {
        if (generation !== homeGeneration) return;
        const message = document.createElement('p'); message.className = 'rose-empty'; message.textContent = error.message || '暂时无法加载影片';
        container.replaceChildren(message, roseBrowseButton('重试', 'refresh', () => showRoseCatalog(kind, page, false)));
    } finally { if (generation === homeGeneration) window.isLoadingHomePageItems = false; }
}

async function loadNextBatchOfHomePageTags() {
    if (window.isLoadingHomePageItems || window.noMoreHomePageTags) return;
    return showRoseCatalog(homeView.kind, homeView.page, false);
}

function initHomePageDoubanContent() {
    try { homeView = JSON.parse(sessionStorage.getItem('roseCatalogState') || '{"kind":"home","page":1}'); } catch { homeView = { kind: 'home', page: 1 }; }
    window.noMoreHomePageTags = false;
    return showRoseCatalog(homeView.kind, homeView.page, false);
}


function initDouban(options = {}) {
    if (window.ROSETV_BRIDGE) { loadUserTags(); initRoseBrowseStyle(); if (!window.homeVideos.size || options.forceMainView) initHomePageDoubanContent(); return; } 
    console.log('[DoubanInit] Initializing Douban with options:', options);
    
    const initialState = options.initialState || null;
    const isFirstLoadOrForceMain = !sessionStorage.getItem('doubanState') && !initialState || options.forceMainView;

    if (initialState && !options.forceMainView) { // 只有在有 initialState 且不是 forceMainView 时才使用它
        window.doubanMovieTvCurrentSwitch = initialState.doubanType || 'movie';
        window.doubanCurrentTag = initialState.selectedTag || '热门';
    } else {
        const storedDoubanStateStr = sessionStorage.getItem('doubanState');
        if (storedDoubanStateStr && !options.forceMainView) { // 只有在有 storedState 且不是 forceMainView 时才使用它
            try {
                const storedState = JSON.parse(storedDoubanStateStr);
                window.doubanMovieTvCurrentSwitch = storedState.doubanType || 'movie';
                window.doubanCurrentTag = storedState.selectedTag || '热门';
            } catch (e) { 
                window.doubanMovieTvCurrentSwitch = 'movie';
                window.doubanCurrentTag = isFirstLoadOrForceMain ? '__HOME__' : '热门'; // 默认或强制首页时用特殊标记
            }
        } else { // 首次加载，或强制主页，或没有有效 storedState
            window.doubanMovieTvCurrentSwitch = 'movie'; // 保持这个默认，因为 initHomePageDoubanContent 依赖它
            window.doubanCurrentTag = isFirstLoadOrForceMain ? '__HOME__' : '热门'; // 默认或强制首页时用特殊标记
        }
    }

    const doubanToggle = document.getElementById('doubanToggle');
    if (doubanToggle) {
        const isEnabled = localStorage.getItem('doubanEnabled') === 'true';
        doubanToggle.checked = isEnabled;
        const toggleBg = doubanToggle.nextElementSibling;
        const toggleDot = toggleBg ? toggleBg.nextElementSibling : null;
        if (toggleBg && toggleDot) {
            if (isEnabled) { 
                toggleBg.classList.add('bg-pink-600'); 
                toggleDot.classList.add('translate-x-6'); 
            } else {
                toggleBg.classList.remove('bg-pink-600');
                toggleDot.classList.remove('translate-x-6');
            }
            doubanToggle.addEventListener('change', function(e) {
                const isChecked = e.target.checked;
                localStorage.setItem('doubanEnabled', isChecked);
                if (isChecked) {
                    toggleBg.classList.add('bg-pink-600');
                    toggleDot.classList.add('translate-x-6');
                } else {
                    toggleBg.classList.remove('bg-pink-600');
                    toggleDot.classList.remove('translate-x-6');
                }
                sessionStorage.removeItem('homePageState');
                for (let i = 0; i < sessionStorage.length; i++) {
                    const key = sessionStorage.key(i);
                    if (key && key.startsWith('douban_api_cache_')) {
                        sessionStorage.removeItem(key);
                        i--; 
                    }
                }
                initHomePageDoubanContent(); 
            });
        }
    }

    loadUserTags(); 

    const newApiSortMap = { '热度': 'T', '时间': 'R', '评分': 'S' };
    const contentTypesForTags = ['电影', '电视剧', '综艺', '动画', '纪录片', '短片'];
    const commonGenres = ['喜剧', '爱情', '动作', '科幻', '悬疑', '犯罪', '惊悚', '恐怖']; 
    const commonCountries = ['中国大陆', '美国', '香港', '日本', '韩国', '英国', '法国']; 

    window.homepageTopNavTags = [];

    contentTypesForTags.forEach(ct => {
        window.homepageTopNavTags.push({ title: ct, typeForCatView: ct, useNewApi: true, apiParams: { tags: ct, sort: newApiSortMap['评分'] } });
    });

    contentTypesForTags.forEach(ct => {
        if (['综艺', '纪录片', '短片'].includes(ct)) return; 
        commonGenres.forEach(genre => {
            if (ct === '动画' && genre === '动画') return;
            window.homepageTopNavTags.push({ title: `${genre}${ct}`, typeForCatView: ct, useNewApi: true, apiParams: { tags: ct, genres: genre, sort: newApiSortMap['热度'] } });
        });
    });

    contentTypesForTags.forEach(ct => {
         if (['综艺', '纪录片', '短片'].includes(ct)) return; 
        commonCountries.forEach(country => {
            window.homepageTopNavTags.push({ title: `${country}${ct}`, typeForCatView: ct, useNewApi: true, apiParams: { tags: ct, countries: country, sort: newApiSortMap['热度'] } });
        });
    });
    
    window.homepageTopNavTags.push({ title: '豆瓣高分电影', typeForCatView: '电影', useNewApi: true, apiParams: { tags: '电影', sort: newApiSortMap['评分'] } });
    window.homepageTopNavTags.push({ title: '近期热门电影', typeForCatView: '电影', useNewApi: true, apiParams: { tags: '电影', sort: newApiSortMap['热度'] } });
    window.homepageTopNavTags.push({ title: '最新电影', typeForCatView: '电影', useNewApi: true, apiParams: { tags: '电影', sort: newApiSortMap['时间'] } });
    window.homepageTopNavTags.push({ title: '热门美剧', typeForCatView: '电视剧', useNewApi: true, apiParams: { tags: '电视剧', countries: '美国', sort: newApiSortMap['热度'] } });
    window.homepageTopNavTags.push({ title: '热门日剧', typeForCatView: '电视剧', useNewApi: true, apiParams: { tags: '电视剧', countries: '日本', sort: newApiSortMap['热度'] } });
    window.homepageTopNavTags.push({ title: '高分日本动画', typeForCatView: '动画', useNewApi: true, apiParams: { tags: '动画', countries: '日本', sort: newApiSortMap['评分'] } });

    Object.keys(movieChartNames).forEach(chartName => {
        window.homepageTopNavTags.push({
            title: chartName,
            typeForCatView: 'movie', 
            useNewApi: false,
            apiTag: movieChartNames[chartName].tag,
            apiSort: movieChartNames[chartName].sort
        });
    });
    Object.keys(tvChartNames).forEach(chartName => {
        window.homepageTopNavTags.push({
            title: chartName,
            typeForCatView: 'tv', 
            useNewApi: false,
            apiTag: tvChartNames[chartName].tag,
            apiSort: tvChartNames[chartName].sort
        });
    });

    const generalMovieTags = ['经典', '豆瓣高分', '冷门佳片', '华语', '欧美', '韩国', '日本', '治愈']; 
    generalMovieTags.forEach(tag => {
        let apiParams = { tags: '电影', sort: newApiSortMap['热度'] }; 
        if (['豆瓣高分', '经典', '冷门佳片'].includes(tag)) apiParams.sort = newApiSortMap['评分'];
        
        if (['华语', '欧美', '韩国', '日本'].includes(tag)) {
             let countryName = tag;
             if (tag === '华语') countryName = '中国大陆'; 
             if (tag === '欧美') countryName = '美国'; 
             apiParams.countries = countryName;
        } else {
             apiParams.genres = tag; 
        }
        if (!['热门', '最新', ...contentTypesForTags].includes(tag)) {
             window.homepageTopNavTags.push({ title: `${tag}电影`, typeForCatView: '电影', useNewApi: true, apiParams });
        }
    });
     const generalTvTags = ['经典', '国产剧', '港剧']; 
     generalTvTags.forEach(tag => {
        let apiParams = { tags: '电视剧', sort: newApiSortMap['热度'] };
        if (tag === '经典') apiParams.sort = newApiSortMap['评分'];

        if (tag === '国产剧') apiParams.countries = '中国大陆';
        else if (tag === '港剧') apiParams.countries = '香港';
        else apiParams.genres = tag;

        if (!['热门', '最新', ...contentTypesForTags].includes(tag)) {
            window.homepageTopNavTags.push({ title: `${tag}`, typeForCatView: '电视剧', useNewApi: true, apiParams });
        }
    });

    const uniqueHomepageNavTags = [];
    const seenNavTitles = new Set();
    for (const tag of window.homepageTopNavTags) {
        if (!seenNavTitles.has(tag.title)) {
            uniqueHomepageNavTags.push(tag);
            seenNavTitles.add(tag.title);
        }
    }
    window.homepageTopNavTags = uniqueHomepageNavTags;


    if (typeof renderDoubanTags === 'function') {
        // 传递 isFirstLoadOrForceMain 给 renderDoubanTags
        renderDoubanTags(window.homepageTopNavTags, isFirstLoadOrForceMain); 
    } else {
        console.error('renderDoubanTags not found in initDouban');
    }
    
    if (isFirstLoadOrForceMain || document.getElementById('page-home').classList.contains('hidden') || !document.getElementById('page-category-view')?.classList.contains('hidden')) {
        initHomePageDoubanContent(); 
    }
    
    let tagToSave = isFirstLoadOrForceMain ? '__HOME__' : window.doubanCurrentTag;
    sessionStorage.setItem('doubanState', JSON.stringify({ doubanType: window.doubanMovieTvCurrentSwitch, selectedTag: tagToSave }));
}

function navigateToCategoryView(categoryName, type, sourceConfig = null) {
    document.querySelectorAll('.page-content').forEach(p => {
        if (p.id !== 'page-category-view') { 
            p.classList.add('hidden');
        }
    });

    const categoryViewPage = document.getElementById('page-category-view');
    if (categoryViewPage) {
        categoryViewPage.classList.remove('hidden');
    } else {
        console.error('page-category-view not found!');
        return;
    }
    
    document.querySelectorAll('#bottomNav .nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.page === 'home') {
            item.classList.add('active');
        }
    });
    sessionStorage.setItem('activeTab', 'home'); 
    sessionStorage.setItem('previousTab', 'home'); 

    window.currentCategoryViewTag = categoryName;
    window.currentCategoryViewType = type;
    window.currentCategorySourceConfig = sourceConfig; 

    window.currentCategoryPageStart = 0;
    window.isLoadingCategoryItems = false;
    window.noMoreCategoryItems = false;

    const titleEl = document.getElementById('category-view-title');
    if (titleEl) titleEl.textContent = categoryName.replace(/</g, '<').replace(/>/g, '>');
    
    const gridEl = document.getElementById('category-items-grid');
    if (gridEl) gridEl.innerHTML = ''; 

    loadMoreCategoryItems(true); 

    window.scrollTo(0, 0); 
}

async function loadMoreCategoryItems(isInitialLoad = false) {
    const categoryViewPage = document.getElementById('page-category-view');
    const sourceTagConfig = window.currentCategorySourceConfig; 

    if (!categoryViewPage || categoryViewPage.classList.contains('hidden')) {
        window.isLoadingCategoryItems = false;
        return;
    }
    if (window.isLoadingCategoryItems || window.noMoreCategoryItems) return;

    window.isLoadingCategoryItems = true;
    const spinner = document.getElementById('category-loading-spinner');
    if (spinner) spinner.classList.remove('hidden');

    let url;
    let usingNewAPIForCategory = false;
    const useOnlyOldApiCategory = localStorage.getItem('doubanApiMode') !== 'true'; // Default to old API


    if (!useOnlyOldApiCategory && sourceTagConfig && sourceTagConfig.useNewApi && sourceTagConfig.apiParams) {
        const paramsForNewApi = { ...sourceTagConfig.apiParams }; 
        paramsForNewApi.start = window.currentCategoryPageStart.toString();
        paramsForNewApi.range = '0,10'; 
        usingNewAPIForCategory = true; 
    } else { 
        // Use Old API logic for category view
        let apiTagForOld;
        if (sourceTagConfig) {
            // If coming from a homepage section, use its defined apiTag if available, otherwise title.
            // The apiTag in sourceConfig should be the actual tag name (e.g., "综艺", "动画")
            apiTagForOld = sourceTagConfig.apiTag || sourceTagConfig.title;
        } else {
            // If navigating directly to category view (e.g. from top nav), currentCategoryViewTag is the title/tag.
            apiTagForOld = window.currentCategoryViewTag;
        }

        let apiSortForOld = 'recommend'; 
        let typeForOldApi = sourceTagConfig ? sourceTagConfig.typeForCatView : window.currentCategoryViewType;

        // Ensure typeForOldApi is 'movie' or 'tv'
        if (typeForOldApi !== 'movie' && typeForOldApi !== 'tv') {
             if (['动画', '短片', '纪录片'].includes(typeForOldApi)) typeForOldApi = 'movie';
             else if (typeForOldApi === '综艺') typeForOldApi = 'tv';
             else typeForOldApi = 'movie'; // Default for other unknown types
        }
        
        // Determine sort order for old API
        if (sourceTagConfig) {
            if (sourceTagConfig.useNewApi && sourceTagConfig.apiParams && sourceTagConfig.apiParams.sort) {
                const sortMap = { 'T': 'recommend', 'R': 'time', 'S': 'rank' };
                apiSortForOld = sortMap[sourceTagConfig.apiParams.sort] || 'recommend';
            } else if (!sourceTagConfig.useNewApi && sourceTagConfig.apiSort) {
                apiSortForOld = sourceTagConfig.apiSort;
            }
        }
        // If no sourceConfig or sort not derived, it defaults to 'recommend'
        
        const doubanApiBase = 'https://movie.douban.com';
        url = `${doubanApiBase}/j/search_subjects?type=${typeForOldApi}&tag=${encodeURIComponent(apiTagForOld)}&sort=${apiSortForOld}&page_limit=${window.categoryItemsPerPage}&page_start=${window.currentCategoryPageStart}`;
        console.log(`[CategoryView] (${useOnlyOldApiCategory ? 'Old API Mode' : 'Old API Config'}) Fetching: ${url}`);
    }
    
    try {
        let data;
        if (usingNewAPIForCategory && !useOnlyOldApiCategory) { 
            const fetchParams = { ...sourceTagConfig.apiParams }; 
            fetchParams.start = window.currentCategoryPageStart.toString();
            fetchParams.range = '0,10'; 
            console.log(`[CategoryView] (New API Preferred) Fetching with params:`, fetchParams);
            data = await fetchNewDoubanSearch(fetchParams);
        } else {
            data = await fetchDoubanData(url); 
        }
        
        if (!data || !data.subjects || !Array.isArray(data.subjects)) {
            console.error("Invalid data structure for category items:", data);
            window.noMoreCategoryItems = true;
            if (spinner) spinner.innerHTML = isInitialLoad ? '<p class="text-gray-500">此分类下暂无内容</p>' : '<p class="text-gray-500">没有更多内容了</p>';
            window.isLoadingCategoryItems = false;
            return;
        }

        if (typeof renderCategoryGridCards === 'function') { 
            renderCategoryGridCards(data, document.getElementById('category-items-grid'));
        } else {
            console.error('renderCategoryGridCards function not found');
        }

        if (data.subjects.length < window.categoryItemsPerPage) {
            window.noMoreCategoryItems = true;
            if (spinner) spinner.innerHTML = '<p class="text-gray-500">没有更多内容了</p>';
        } else if (data.subjects.length === 0 && isInitialLoad) { 
             window.noMoreCategoryItems = true;
             if (spinner) spinner.innerHTML = '<p class="text-gray-500">此分类下暂无内容</p>';
        }
        window.currentCategoryPageStart += data.subjects.length; 
    } catch (error) {
        console.error("Error loading category items:", error);
        if (spinner) spinner.innerHTML = '<p class="text-red-500">加载失败，请稍后重试</p>';
        window.noMoreCategoryItems = true; 
    } finally {
        window.isLoadingCategoryItems = false;
        if (window.noMoreCategoryItems && spinner && spinner.innerHTML.includes('加载更多')) {
            // No change needed if already showing "no more"
        } else if (!window.noMoreCategoryItems && spinner) {
             spinner.classList.add('hidden'); 
        }
    }
}

function handleScroll() {
    // Use documentElement for better compatibility across browsers/platforms
    const scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
    const scrollHeight = document.documentElement.scrollHeight;
    const clientHeight = document.documentElement.clientHeight;

    const isNearBottom = scrollTop + clientHeight >= scrollHeight - 300;

    if (!isNearBottom) return;

    const categoryViewPage = document.getElementById('page-category-view');
    const homePage = document.getElementById('page-home');
    const filterPage = document.getElementById('page-filter');

    if (categoryViewPage && !categoryViewPage.classList.contains('hidden')) {
        loadMoreCategoryItems(false);
    } else if (homePage && !homePage.classList.contains('hidden') && localStorage.getItem('doubanEnabled') === 'true') {
        if (!window.isLoadingHomePageItems && !window.noMoreHomePageTags) {
            const recommendationsContainer = document.getElementById('douban-recommendations-container');
            if (recommendationsContainer && recommendationsContainer.offsetParent !== null) {
                loadNextBatchOfHomePageTags();
            }
        }
    } else if (filterPage && !filterPage.classList.contains('hidden')) {
        if (typeof handleSearchPageScroll === 'function') {
            handleSearchPageScroll();
        }
    }
}

// Listen on both window and document to maximize compatibility
window.addEventListener('scroll', handleScroll, { passive: true });
document.addEventListener('scroll', handleScroll, { passive: true });

function showTagManageModal() { 
    console.warn("showTagManageModal called - UI for this needs to be ensured or created.");
}
function addTag(tag) { 
    console.warn("addTag called - UI for this needs to be ensured or created.");
}
function deleteTag(tag) { 
    console.warn("deleteTag called - UI for this needs to be ensured or created.");
}
function resetTagsToDefault() { 
    console.warn("resetTagsToDefault called - UI for this needs to be ensured or created.");
}

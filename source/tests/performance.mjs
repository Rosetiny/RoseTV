import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const directory = new URL('../public/js/', import.meta.url);
const source = name => fs.readFileSync(new URL(name, directory), 'utf8');
const defer = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function environment(invoke) {
    const ids = new Map();
    class Element {
        constructor(tag = 'div') {
            this.tagName = tag; this.children = []; this.style = {}; this.value = ''; this.textContent = ''; this.dataset = {}; this.attributes = {};
            this.classes = new Set();
            this.classList = { add: (...a) => a.forEach(v => this.classes.add(v)),
                remove: v => this.classes.delete(v), contains: v => this.classes.has(v),
                toggle: (v, force) => { if (force ?? !this.classes.has(v)) this.classes.add(v); else this.classes.delete(v); } };
        }
        set id(value) { this._id = value; ids.set(value, this); }
        get id() { return this._id; }
        append(...nodes) { nodes.forEach(n => {for(const child of n?.tagName === 'fragment' ? n.children : [n]){this.children.push(child);if(child&&typeof child==='object')child.parentElement=this;}}); }
        prepend(...nodes) { this.children.unshift(...nodes); }
        replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
        setAttribute(name, value) { this.attributes[name] = value; }
        getAttribute(name) { return this.attributes[name] ?? null; }
        removeAttribute(name) { delete this.attributes[name]; }
        before() {}
        remove() { if(this.parentElement){const siblings=this.parentElement.children;siblings.splice(siblings.indexOf(this),1);this.parentElement=null;} }
        closest() { return null; }
        querySelector(tag) { return this.children.find(child => tag.startsWith('.')?String(child?.className||'').split(/\s+/).includes(tag.slice(1)):child?.tagName === tag) || null; }
        addEventListener(type,listener) { (this.listeners ||= new Map()).set(type,listener); }
        dispatchEvent(event) { this.listeners?.get(event.type)?.(event); }
    }
    for (const id of ['searchInput', 'results', 'resultsArea', 'searchResultsCount', 'modal', 'modalContent',
        'modalTitle', 'playerContainer', 'player', 'loading', 'error', 'error-message']) {
        const element = new Element(); element.id = id;
    }
    const storage = () => {
        const data = new Map();
        return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
    };
    const context = vm.createContext({ console, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, queueMicrotask, Date,
        document: { createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'),
            createTextNode: text => Object.assign(new Element('#text'), { textContent: text }),
            createElementNS: (_, tag) => new Element(tag), head: new Element('head'), addEventListener() {}, querySelectorAll: () => [],
            getElementById: id => ids.get(id) || null },
        localStorage: storage(), sessionStorage: storage(), window: {}, navigator: {},
        tauriConstants: { invoke }, API_SITES: { fast: { name: 'Fast', api: 'https://fast.test' },
            slow: { name: 'Slow', api: 'https://slow.test' } },
        API_CONFIG: { search: { pagePath: '/api?wd={query}&pg={page}', headers: {} }, detail: { path: '/detail?ids=', headers: {} } },
        selectedAPIs: ['fast', 'slow'], currentEpisodes: [], currentVideoTitle: '', episodesReversed: false,
        getCustomApiInfo: () => null, showToast() {}, showPasswordModal() {}, hideLoading() {}, playVideo() {} });
    context.window = context;
    const run = code => vm.runInContext(code, context);
    run(source('apiRequestCore.js')); run(source('rosetv.js').split('/* RoseTV navigation')[0]); run(source('search_logic.js')); run(source('details_modal.js'));
    return { context, run, ids, Element };
}
const row = (id, name = id) => ({ vod_id: id, vod_name: name, vod_play_from: 'direct',
    vod_play_url: '正片$https://video.test/' + id + '.m3u8' });
const reply = (rows, pages = 1) => ({ status: 200, headers: { 'content-type': 'text/html' },
    body: JSON.stringify({ list: rows, pagecount: pages }) });

// Parallel duplicates share a request; deadlines release the UI and never poison the cache.
{
    let calls = 0;
    const request = defer();
    const env = environment(() => { calls++; return request.promise; });
    const first = env.run("executeApiRequest('https://cache.test/a')");
    const second = env.run("executeApiRequest('https://cache.test/a')");
    assert.equal(calls, 1);
    request.resolve(reply([row('cached')]));
    await Promise.all([first, second]);
    await env.run("executeApiRequest('https://cache.test/a')");
    assert.equal(calls, 1);
    env.context.tauriConstants.invoke = () => new Promise(() => {});
    const started = Date.now();
    await assert.rejects(env.run("executeApiRequest('https://hung.test/a', {timeoutSecs: 0.02})"), /超时/);
    assert.ok(Date.now() - started < 500);
    assert.equal(env.run('apiPending.size'), 0);
    env.context.tauriConstants.invoke = async () => reply([]);
    for (let i = 0; i < 90; i++) await env.run("executeApiRequest('https://bounded.test/" + i + "')");
    assert.equal(env.run('apiCache.size'), 80);
}

// First results appear while a slow source is pending. No eager pagination.
{
    const slow = defer();
    const calls = [];
    const env = environment((_, { options }) => {
        calls.push(options.url);
        return options.url.includes('slow.test') ? slow.promise : Promise.resolve(reply([row('fast')], 50));
    });
    env.ids.get('searchInput').value = '电影';
    const search = env.run('search()');
    await tick();
    assert.equal(env.run('searchRows.length'), 1);
    assert.equal(calls.length, 2);
    assert.equal(env.run('searchBusy'), true);
    await env.run("showDetails('fast', '电影', 'fast')");
    assert.equal(calls.length, 2, 'Cached search details must not add a network round trip');
    assert.equal(env.context.currentEpisodes.length, 1);
    slow.resolve(reply([row('slow')]));
    await search;
    assert.equal(env.run('searchRows.length'), 2);
    assert.equal(calls.length, 2);
    await env.run('loadSearchPages(searchGeneration)');
    assert.equal(calls.length, 3, 'Only the source with more pages should paginate');
}

// A previous query cannot overwrite a newer query, even when it completes later.
{
    const old = defer(), next = defer();
    const env = environment((_, { options }) => options.url.includes('wd=old') ? old.promise : next.promise);
    env.context.selectedAPIs = ['fast'];
    env.ids.get('searchInput').value = 'old';
    const first = env.run('search()');
    env.ids.get('searchInput').value = 'new';
    const second = env.run('search()');
    next.resolve(reply([row('new')]));
    await second;
    old.resolve(reply([row('old')]));
    await first;
    assert.equal(env.run('searchRows[0].vod_id'), 'new');
    assert.equal(env.run('searchRows.length'), 1);
}

// Closed/replaced detail dialogs stay closed; names/URLs are data, never inline JS.
{
    const pending = defer();
    const env = environment(() => pending.promise);
    const details = env.run("showDetails('42', 'O\\'Brien <script>', 'fast')");
    env.run("window.cancelDetailLoad(); document.getElementById('modal').classList.add('hidden')");
    pending.resolve(reply([row('42')]));
    await details;
    assert.equal(env.context.currentEpisodes.length, 0);
    const groups = env.run("parsePlaybackGroups({vod_play_from:'parser$$$direct',vod_play_url:'解析$https://video.test/a.html$$$正片$https://video.test/a.m3u8#无效$javascript:alert(1)'})");
    assert.equal(groups[0].name, 'direct');
    assert.equal(groups[0].episodes.length, 1);
    assert.equal(groups[0].episodes[0].name, '正片');
    assert.equal(env.run("resourceQuality({vod_remarks:'HD'}).rank"), 0, 'HD must not be invented as 1080P');
    assert.equal(env.run("resourceQuality({vod_remarks:'TC 4K'}).rank"), -1);
}

// Preserve required HLS timeline markers and expose measured, not invented, resolution.
{
    const env = environment(async () => reply([]));
    env.context.Hls = { DefaultConfig: { loader: class {} } };
    const ui = source('ui.js');
    env.run(ui.slice(0, ui.indexOf('const roseIconPaths')));
    env.run(source('player_dplayer_handler.js'));
    const playlist = '#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:4,\nb.ts';
    env.context.playlist = playlist;
    assert.equal(env.run('filterAdsFromM3U8(playlist, true)'), playlist);
    env.context.testVideo = { videoWidth: 1920, videoHeight: 1080, playbackRate: 1, currentTime: 36, pause() {} };
    env.context.dp = { video: env.context.testVideo };
    env.context.testHls = { levels: [{ height: 720 }, { height: 1080 }] };
    env.context.location = { search: '?title=test&source_code=fast', href: 'http://tauri.localhost/player.html?title=test&source_code=fast' };
    env.context.history = { replaceState() {} };
    env.context.currentVideoUrl = 'https://video.test/first.m3u8';
    env.context.currentEpisodeIndex = 0;
    env.context.playEpisode = index => { env.context.playedIndex = index; };
    env.context.sessionStorage.setItem('playbackLines', JSON.stringify({ title: 'test', sourceCode: 'fast', groups: [
        { name: 'First', episodes: [{ url: 'https://video.test/first.m3u8' }] },
        { name: 'Second', episodes: [{ url: 'https://video.test/second.m3u8' }] }
    ] }));
    env.run('playbackQualityControls(testVideo, testHls, true)');
    const bar = env.ids.get('playbackQualityBar');
    assert.match(bar.children[0].textContent, /1920 × 1080/);
    const select = env.ids.get('playbackQuality');
    assert.equal(select.disabled, false);
    select.value = '1'; select.onchange();
    assert.equal(env.context.testHls.currentLevel, 1);
    const speed = bar.children[2];
    speed.value = '1.5'; speed.onchange();
    assert.equal(env.context.testVideo.playbackRate, 1.5);
    const line = bar.children[3];
    assert.equal(line.children.length, 2);
    line.value = '1'; line.onchange();
    assert.equal(env.context.currentEpisodes[0], 'https://video.test/second.m3u8');
    assert.equal(env.context.playedIndex, 0);
    assert.equal(JSON.parse(env.context.localStorage.getItem('videoProgress_https://video.test/second.m3u8')).position, 36);
}
// Returning home preserves live event handlers; reloads rebuild cards from metadata.
{
    const env = environment(async () => reply([]));
    const container = new env.Element(); container.id = 'douban-recommendations-container';
    container.innerHTML = 'live cards';
    const card = new env.Element('button'); card.onclick = () => {};
    container.append(card);
    env.context.HOME_PAGE_STATE_KEY = 'homePageState';
    env.context.sessionStorage.setItem('homePageState', JSON.stringify({ viewMode: 'main', homePageHTML: 'dead saved markup', scrollTop: 20 }));
    env.context.ROSETV_BRIDGE = { enabled: true };
    env.context.homeVideos = new Map([['first', row('first')]]);
    env.context.scrollTo = () => {};
    let loads = 0;
    env.context.loadNextBatchOfHomePageTags = async () => { loads++; };
    const ui = source('ui.js');
    env.run(ui.slice(ui.indexOf('function restoreHomePageState()'), ui.indexOf('function saveFilterPageState()')));
    env.run('restoreHomePageState()');
    assert.equal(container.innerHTML, 'live cards');
    assert.equal(typeof card.onclick, 'function');
    assert.equal(loads, 0);
    env.context.homeVideos.clear();
    env.run('restoreHomePageState()');
    assert.equal(loads, 1);
}
// Filter image formats use the same reliable local image transport and safe DOM.
{
    const env = environment(async () => reply([]));
    const logic = source('douban_logic.js');
    env.run(logic.slice(logic.indexOf('function rosePoster('), logic.indexOf('function roseBrowseButton(')));
    env.context.roseIcon = () => new env.Element('svg');
    env.context.initRoseBrowseStyle = () => {};
    env.context.ROSETV_BRIDGE = { enabled: true, mediaURL: url => 'http://local/image?url=' + encodeURIComponent(url) };
    const ui = source('douban_ui.js');
    env.run(ui.slice(ui.indexOf('function doubanPosterItem(')));
    const input = { title: "O'Brien <script>", pic: { large: 'https://image.test/large.jpg', normal: 'https://image.test/small.jpg' }, rating: { value: 8.5 } };
    env.context.input = input;
    const normalized = env.run('doubanPosterItem(input)');
    assert.equal(normalized.original_pic, 'https://image.test/large.jpg');
    assert.ok(normalized.vod_pic.startsWith('http://local/image?'));
    env.context.posterGrid = new env.Element();
    env.run('renderDoubanSearchResultsGrid({subjects:[input]},posterGrid)');
    const card = env.context.posterGrid.children[0];
    assert.equal(card.dataset.doubanTitle, input.title);
    assert.equal(card.children[1].textContent, input.title);
    const image = card.children[0].children[0];
    assert.equal(image.loading, 'lazy');
    assert.ok(image.src.startsWith('http://local/image?'));
}
// A slower old catalog page cannot replace a newer page's posters or navigation.
{
    const env = environment(async () => reply([]));
    for (const id of ['page-home', 'douban-recommendations-container']) { const el = new env.Element(); el.id = id; }
    env.context.roseIcon = () => new env.Element('svg'); env.context.scrollTo = () => {};
    env.context.bridgeReady = Promise.resolve({ enabled: true, site: true, url: 'http://local' });
    const old = defer(), next = defer();
    env.context.executeApiRequest = url => url.includes('kind=mv') ? old.promise : next.promise;
    const logic = source('douban_logic.js');
    env.run(logic.slice(logic.indexOf('window.homeVideos = new Map();'), logic.indexOf('function initDouban(')));
    const first = env.run("showRoseCatalog('mv',1)");
    const second = env.run("showRoseCatalog('tv',2)");
    await tick();
    next.resolve({ title: 'Series', kind: 'tv', list: [{ vod_id: 'tv_next', vod_name: 'Next', source_code: 'site' }], hasMore: true });
    await second;
    old.resolve({ title: 'Movies', kind: 'mv', list: [{ vod_id: 'mv_old', vod_name: 'Old', source_code: 'site' }] });
    await first;
    assert.equal(env.run("homeVideos.has('site:tv_next')"), true);
    assert.equal(env.run("homeVideos.has('site:mv_old')"), false);
    assert.equal(env.run('homeView.page'), 2);
}
// Cross-provider switching stays in the player and preserves episode, position and speed.
{
    const env = environment(async () => reply([]));
    const ui = source('ui.js');
    env.run(ui.slice(0, ui.indexOf('const roseIconPaths')));
    let paused = false;
    env.context.dp = { video: { currentTime: 83.5, playbackRate: 1.5, pause() { paused = true; } } };
    env.context.currentVideoTitle = 'Test'; env.context.currentEpisodeIndex = 1;
    env.context.location = { href: 'http://tauri.localhost/player.html?title=Test&source_code=site' };
    env.context.history = { replaceState: (_, __, url) => { env.context.replacedURL = String(url); } };
    env.context.playEpisode = index => { env.context.playedIndex = index; };
    env.run("selectRosePlayback('fast','Fast',[{name:'Direct',episodes:[{url:'https://video.test/1.m3u8'},{url:'https://video.test/2.m3u8'}]}])");
    assert.equal(paused, true);
    assert.equal(env.context.playedIndex, 1);
    assert.equal(JSON.parse(env.context.localStorage.getItem('videoProgress_https://video.test/2.m3u8')).position, 83.5);
    assert.equal(new URL(env.context.replacedURL).searchParams.get('source_code'), 'fast');
    assert.equal(new URL(env.context.replacedURL).searchParams.get('position'), '83.5');
    assert.equal(JSON.parse(env.context.sessionStorage.getItem('playbackLines')).sourceCode, 'fast');
    assert.equal(env.context.dp.video.playbackRate, 1.5);
    env.context.sessionStorage.setItem('roseCurrentItem',JSON.stringify({vod_name:'Test',source_code:'fast',vod_douban_id:42}));
    env.run("selectRosePlayback('site','Site',[{name:'Direct',episodes:[{url:'https://video.test/site.m3u8'}]}],0,{vod_id:'mv_42',vod_name:'Test',site_resources:{panlist:{url:['https://pan.example/42'],name:['Test']}}})");
    const switched=JSON.parse(env.context.sessionStorage.getItem('roseCurrentItem'));
    assert.equal(switched.source_code,'site');assert.equal(switched.vod_id,'mv_42');assert.equal(switched.vod_douban_id,42);
    assert.equal(switched.site_resources.panlist.url[0],'https://pan.example/42','Switching sources must carry download details too');
}
console.log('PASS: progressive search, bounded cache, navigation, posters, stale pages, cross-provider switching and playback controls');

// Large API replies are evicted by capacity, rather than retaining 80 large objects.
{
    const env = environment(async () => ({status:200,body:JSON.stringify({payload:'x'.repeat(240000)})}));
    for (let i=0;i<12;i++) await env.run("executeApiRequest('https://capacity.test/"+i+"')");
    assert.ok(env.run('apiCacheBytes') <= 4*1024*1024);
    assert.ok(env.run('apiCache.size') < 12);
}
// Replacing a player removes all previous touch handlers from its persistent container.
{
    const env = environment(async()=>reply([]));
    const target = new EventTarget(), video = new EventTarget(), signals = [];
    video.paused=false; video.playbackRate=1;
    const add=target.addEventListener.bind(target);
    target.addEventListener=(type,callback,options)=>{ signals.push(options.signal);add(type,callback,options); };
    env.ids.set('player',target);env.context.dp={video};env.context.navigator.userAgent='Desktop';
    env.run(source('player_utils.js'));
    for(let i=0;i<12;i++)env.run('setupLongPressSpeedControl()');
    assert.equal(signals.filter(signal=>!signal.aborted).length,4);
    assert.ok(signals.slice(0,-4).every(signal=>signal.aborted));
}
console.log('PASS: memory capacity and repeated player cleanup');

// DPlayer 1.26 leaves document and container handlers behind; teardown must remove both.
{
    const env=environment(async()=>reply([]));let active=0,destroyed=0;
    const container=env.ids.get('player');
    for(const target of [env.context.document,env.context,container]){target.addEventListener=()=>{active++;};target.removeEventListener=()=>{active--;};}
    env.context.DPlayer=class {
        constructor(options){this.container=options.container;this.video={replaceChildren(){},removeAttribute(){},load(){}};for(const target of [env.context.document,env.context,this.container])target.addEventListener('keydown',()=>{});}
        destroy(){destroyed++;}
    };
    const handler=source('player_dplayer_handler.js');
    env.run(handler.slice(handler.indexOf('function createRosePlayer'),handler.indexOf('function playbackQualityControls')));
    for(let i=0;i<20;i++){const player=env.run("createRosePlayer({container:document.getElementById('player')})");assert.equal(active,3);player.destroy();player.destroy();assert.equal(active,0);}
    assert.equal(destroyed,20);
}
console.log('PASS: global and persistent-container listener teardown');

// Home "more" resets stale filters; the full filter catalog remains selectable.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html'};
    env.run(source('ui.js'));env.run(source('rosetv.js'));
    let kind;env.context.navigateToTab=(page,target)=>{assert.equal(page,'home');kind=target;};
    env.run("roseFilters.mv={genre:'喜剧',year:'1990年代'};roseMore('mv')");
    assert.equal(kind,'mv');assert.equal(env.run('roseFilters.mv.sort'),'U');assert.equal(env.run('roseFilters.mv.year'),'近三年');assert.equal(env.run('roseFilters.mv.genre'),undefined);
    const panel=new env.Element();env.context.testPanel=panel;env.run("roseFilterRows('mv',testPanel)");
    const labels=panel.children[0].children[1].children.map(button=>button.textContent);
    for(const label of ['歌舞','儿童','惊悚','武侠','治愈','真人秀','脱口秀','情色'])assert.ok(labels.includes(label));
    for(let i=0;i<205;i++)env.run("roseToggleFavorite({vod_name:'Favorite "+i+"',vod_year:2026})");assert.equal(env.run('roseSaved().length'),200);
    env.context.localStorage.setItem('viewingHistory',JSON.stringify([{title:'Film',sourceName:'Fast',episodes:['https://video.test/a.m3u8']} ]));
    let address;env.context.showVideoPlayer=value=>{address=new URL(value);};env.run("playFromHistory('player.html?url=https%3A%2F%2Fvideo.test%2Fa.m3u8','Film',0,120)");
    assert.equal(address.pathname,'/player.html');assert.equal(address.searchParams.get('position'),'120');assert.equal(address.searchParams.get('source_code'),'fast');
    assert.equal(env.run("roseDownloadLinks({vod_down_from:'磁力',vod_down_url:'1080P$magnet:?xt=urn:btih:abcd$$$4K$javascript:alert(1)'}).length"),1);
    assert.equal(env.run("roseDownloadLinks({site_resources:{downlist:{list:{m:['0123456789012345678901234567890123456789'],t:['Film.2160p'],s:['12 GB']}},panlist:{url:['https://pan.example/test'],name:['Film'],p:['1234']}}}).length"),2);
}
console.log('PASS: recent-hot presets, expanded filters, bounded favorites and history resume');

// Clearing history cannot be undone by an older player's delayed save callback.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html'};
    env.run(source('ui.js'));let saves=0;env.context.saveToHistory=()=>{saves++;};env.run(source('rosetv.js'));
    env.run('saveToHistory()');assert.equal(saves,1);
    env.run("localStorage.setItem('roseHistoryClearedAt',Date.now()+1000);saveToHistory()");assert.equal(saves,1);
    env.run("roseHistoryStartedAt=Number(localStorage.getItem('roseHistoryClearedAt'))+1;saveToHistory()");assert.equal(saves,2);
}
console.log('PASS: cleared history does not reappear from stale player callbacks');

// Same-name films keep their year/season, and large download groups cannot hide later cloud links.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html'};
    env.run(source('ui.js'));env.run(source('rosetv.js'));
    assert.equal(env.run("roseMatchVideo({vod_name:'奥德赛（2026）',vod_year:'2026'},'奥德赛',2026)"),true);
    assert.equal(env.run("roseMatchVideo({vod_name:'奥德赛',vod_year:'2025'},'奥德赛',2026)"),false);
    assert.equal(env.run("roseMatchVideo({vod_name:'心动的信号第9季'},'心动的信号 第九季')"),true);
    assert.equal(env.run("roseMatchVideo({vod_name:'心动的信号第八季'},'心动的信号 第九季')"),false);
    assert.equal(env.run("roseTitleIdentity('2012',2009).title"),'2012');
    assert.ok(env.run("roseSearchScore({vod_name:'奥德赛2026',vod_year:2026},'奥德赛')>roseSearchScore({vod_name:'北极熊：一个夏天的奥德赛'},'奥德赛')"));
    const hashes=Array.from({length:150},(_,i)=>i.toString(16).padStart(40,'0'));
    env.context.largeDownload={site_resources:{downlist:{list:{m:hashes}},panlist:{url:Array.from({length:151},(_,i)=>'https://pan.example/'+i)}}};
    assert.equal(env.run('roseDownloadLinks(largeDownload).length'),301);
    env.context.localStorage.setItem('selectedAPIs','["fast","slow"]');
    env.context.roseFindVideo=async()=>({...row('good'),source_code:'slow',vod_year:'2026'});
    let played;env.context.playVideo=(url)=>{played=url;};
    await env.run("roseOpenVideo({vod_id:'empty',vod_name:'good',source_code:'fast',vod_year:'2026',vod_play_url:'bad'})");
    assert.equal(played,'https://video.test/good.m3u8');
    const early={...row('early'),vod_play_url:'TC$https://video.test/early.m3u8'};env.context.early=early;
    await assert.rejects(env.run('roseVideoGroups(early)'),error=>!!error.earlyItem);
    assert.equal((await env.run('roseVideoGroups(early,true)')).groups.length,1);
}
console.log('PASS: release-year/season identity, relevance, fallback on empty detail, explicit early versions and complete download groups');

// A slow, unrelated source cannot delay a playable match from another source.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html'};
    env.run(source('ui.js'));env.run(source('rosetv.js'));env.context.localStorage.setItem('selectedAPIs','["fast","slow"]');
    const slow=defer();env.context.roseFindVideo=async id=>id==='slow'?slow.promise:{...row('winner'),source_code:'fast'};
    let played;env.context.playVideo=url=>{played=url;};
    const opening=env.run("roseOpenVideo({vod_name:'winner',source_code:'metadata'})");
    await tick();assert.equal(played,'https://video.test/winner.m3u8');slow.resolve(null);await opening;
}
console.log('PASS: first playable match does not wait for a slow source');

// Generic source categories cannot stand in for movie genres; linked genres reset stale filters.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html',search:''};
    env.context.DOMParser=class{parseFromString(value){return{body:{textContent:value}};}};
    env.run(source('ui.js'));env.run(source('rosetv.js'));
    assert.equal(env.run("roseMovieGenres({vod_class:'其它',type_name:'伦理片'}).length"),0);
    assert.equal(env.run("roseMovieGenres({vod_class:'剧情,战争,情色,剧情片'}).join(',')"),'剧情,战争,情色');
    assert.equal(env.run("roseMovieGenres({type_name:'喜剧片'})[0]"),'喜剧');
    assert.equal(env.run("isShortDrama({type_name:'言情总裁'})"),true);
    assert.equal(env.run("isShortDrama({type_name:'剧情片'})"),false);
    assert.equal(env.run("roseVideoKind({type_name:'动漫电影'})"),'mv');
    assert.equal(env.run("roseVideoKind({type_name:'欧美剧'})"),'tv');
    const panel=new env.Element();env.context.testPanel=panel;
    env.run("roseRenderMovieInfo(testPanel,{vod_name:'西西里的美丽传说',vod_class:'剧情,战争,情色',type_name:'剧情片'})");
    assert.equal(panel.querySelector('h2').textContent,'西西里的美丽传说');
    const buttons=panel.querySelector('dl').children[0].children[1].children;
    assert.deepEqual(buttons.map(button=>button.textContent),['剧情','战争','情色']);
    let navigation;env.context.roseNavigate=(page,kind)=>{navigation={page,kind};};
    env.run("roseFilters.mv={genre:'恐怖',genreMode:'exclude',year:'2026',rating:'9.5',quality:'4k'}");
    buttons[2].onclick();
    assert.deepEqual(navigation,{page:'home',kind:'mv'});
    assert.equal(env.run('JSON.stringify(roseFilters.mv)'),JSON.stringify({genre:'情色',genreMode:'single',sort:'S'}));
    let forwarded;env.context.parent={roseBrowseGenre:(item,genre)=>{forwarded=genre;}};
    env.run("window.roseEmbedded=true;roseBrowseGenre({type_name:'剧情片'},'战争')");assert.equal(forwarded,'战争');
}
console.log('PASS: visible movie title, real genre chips and navigation without stale conditions');

// Existing actors/synopsis must not suppress enrichment of a missing genre.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/player.html',href:'http://tauri.localhost/player.html',search:'?source_code=fast'};
    env.context.DOMParser=class{parseFromString(value){return{body:{textContent:value}};}};
    const panel=new env.Element();panel.id='roseMovieInfo';env.context.bridgeReady=Promise.resolve();
    env.run(source('ui.js'));env.run(source('rosetv.js'));env.context.currentVideoTitle='Film';
    env.context.localStorage.setItem('selectedAPIs','["fast"]');
    env.context.sessionStorage.setItem('roseCurrentItem',JSON.stringify({vod_id:1,vod_name:'Film',vod_year:'2000',source_code:'fast',type_name:'伦理片',vod_class:'其它',vod_actor:'Original actor',vod_content:'Original synopsis'}));
    let calls=0;env.context.roseFindVideo=async()=>{calls++;return{vod_id:999,vod_name:'Film',vod_year:'2000',source_code:'slow',vod_class:'剧情,战争,情色',vod_actor:'Other actor'};};
    env.run('roseLoadMovieInfo()');await tick();assert.equal(calls,0,'Missing info does not trigger speculative searches');
    await panel.children.at(-1).onclick();
    const item=JSON.parse(env.context.sessionStorage.getItem('roseCurrentItem'));
    assert.equal(calls,1);assert.equal(item.vod_class,'剧情,战争,情色');assert.equal(item.vod_actor,'Original actor');assert.equal(item.vod_id,1);assert.equal(item.source_code,'fast');
}
console.log('PASS: missing genres are enriched independently from actors and synopsis');

// Unknown totals offer a useful window; exact emptiness and real last pages remain bounded.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html',search:''};
    env.run(source('ui.js'));env.run(source('rosetv.js'));let target;env.context.showRoseCatalog=(kind,page)=>{target=page;};
    const numeric=nav=>nav.children.filter(child=>child.tagName==='button'&&/^\d+$/.test(child.textContent)).map(button=>Number(button.textContent));
    const unknown=env.run("roseCatalogPagination('mv',2,{list:[{}],hasMore:true},[0])");
    assert.deepEqual(numeric(unknown),[1,2,3,4,5,6,7]);
    assert.match(unknown.children.at(-1).textContent,/总页数未提供/);
    const jump=unknown.querySelector('form');assert.equal(jump.children[0].max,'10000');jump.children[0].value='100';jump.onsubmit({preventDefault(){}});assert.equal(target,100);
    const known=env.run("roseCatalogPagination('mv',2,{list:[{}],pages:200,hasMore:true},[0])");assert.ok(numeric(known).includes(200));assert.equal(known.querySelector('form').children[0].max,'200');
    const terminal=env.run("roseCatalogPagination('mv',3,{list:[{}],hasMore:false},[0])");assert.equal(terminal.children.find(x=>x.textContent==='下一页').disabled,true);assert.equal(terminal.querySelector('form').children[0].max,'3');
    const empty=env.run("roseCatalogPagination('mv',100,{list:[],hasMore:false},[0])");assert.match(empty.children.at(-1).textContent,/暂无结果/);
    const zero=env.run("roseCatalogPagination('mv',1,{list:[],hasMore:false},[0])");assert.deepEqual(numeric(zero),[1]);assert.equal(zero.querySelector('form').hidden,true);assert.equal(zero.children.find(x=>x.textContent==='下一页').disabled,true);assert.match(zero.children.at(-1).textContent,/暂无匹配/);
    const exact=env.run("roseCatalogPagination('mv',1,{list:[],hasMore:false,total:0,pages:1},[0])");assert.deepEqual(numeric(exact),[1]);
    const scanning=env.run("roseCatalogPagination('mv',1,{list:[],hasMore:true,nextCursor:64},[0,64])");assert.deepEqual(numeric(scanning),[1,2]);assert.equal(scanning.children.find(x=>x.textContent==='下一页').disabled,false);
    const cursor=env.run("roseCatalogPagination('mv',2,{list:[{}],nextCursor:128,hasMore:true},[0,64,128])");assert.deepEqual(numeric(cursor),[1,2,3]);assert.match(cursor.children.at(-1).textContent,/按顺序加载/);
}
console.log('PASS: numbered navigation, exact empty/last pages, direct jumps and sequential cursor safety');

// Stable subject IDs survive missing listing years and never mix same-name remakes.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html',search:''};
    env.run(source('ui.js'));env.run(source('rosetv.js'));
    env.context.localStorage.setItem('roseMovieMetadata',JSON.stringify({'film|2026':{time:Date.now()-86400000,fields:{vod_douban_id:'42',vod_year:'2026',vod_area:'美国',vod_class:'科幻 / 惊悚'}}}));
    const item={vod_id:'42',vod_name:'Film',source_code:'metadata'};env.context.metadataItem=item;env.run('roseUseMetadata(metadataItem)');
    assert.equal(item.vod_year,'2026');assert.equal(item.vod_area,'美国');assert.equal(item.vod_class,'科幻 / 惊悚');
    env.run('roseRememberMetadata(metadataItem);roseFlushMetadata()');assert.ok(JSON.parse(env.context.localStorage.getItem('roseMovieMetadata'))['douban:42']);
    const remake={vod_id:'43',vod_name:'Film',source_code:'metadata'};env.context.metadataItem=remake;env.run('roseUseMetadata(metadataItem)');assert.equal(remake.vod_class,undefined);
    env.context.metadataItem={vod_id:'42',vod_name:'Film',source_code:'metadata',vod_class:'科幻'};env.run('roseRememberMetadata(metadataItem)');
    assert.equal(JSON.parse(env.context.localStorage.getItem('roseMovieMetadata'))['douban:42'].fields.vod_class,'科幻 / 惊悚');
}
console.log('PASS: persistent metadata uses exact subject IDs, migrates old cache and preserves complete fields');

// An out-of-range jump returns to a previously loaded page instead of inventing page numbers.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html',search:''};
    env.run(source('ui.js'));env.run(source('rosetv.js'));env.ids.set('douban-recommendations-container',new env.Element());
    env.context.roseBrowseLimit=()=>16;env.context.initRoseBrowseStyle=()=>{};env.context.renderRoseBrowseNav=()=>{};env.context.roseFilterRows=()=>{};env.context.rosePoster=()=>new env.Element('button');env.context.showToast=()=>{};env.context.bridgeReady=Promise.resolve({url:'http://bridge.test'});
    const requested=[];env.context.executeApiRequest=async address=>{const page=Number(new URL(address).searchParams.get('page'));requested.push(page);return page===100?{list:[],hasMore:false}:{list:[{vod_id:'one',vod_name:'Film',source_code:'metadata'}],hasMore:true};};
    env.context.homeGeneration=0;env.context.homeVideos=new Map();env.context.homeTrail=[];env.run("homeView={kind:'mv',page:2,limit:16,filterKey:'{}',cursors:[0],loadedPage:2}");
    await env.run("showRoseCatalog('mv',100)");assert.deepEqual(requested,[100,2]);assert.equal(env.run('homeView.page'),2);
}
console.log('PASS: empty out-of-range page returns to the last loaded page');

// A failed page request preserves the last successful DOM, selection and clickable pagination.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html',search:''};
    env.run(source('ui.js'));env.run(source('rosetv.js'));const container=new env.Element();env.ids.set('douban-recommendations-container',container);
    env.context.homeGeneration=0;env.context.homeVideos=new Map();env.context.homeTrail=[];
    env.context.roseBrowseLimit=()=>16;env.context.initRoseBrowseStyle=()=>{};env.context.renderRoseBrowseNav=()=>{};env.context.roseFilterRows=()=>{};env.context.showToast=()=>{};
    env.context.rosePoster=item=>Object.assign(new env.Element('button'),{textContent:item.vod_name});env.context.bridgeReady=Promise.resolve({url:'http://bridge.test'});
    env.run("homeView={kind:'mv',page:1,limit:16,filterKey:'{}',cursors:[0]}");
    env.context.executeApiRequest=async()=>({list:[{vod_id:'first',vod_name:'First',source_code:'metadata'}],hasMore:true});
    await env.run("showRoseCatalog('mv',1)");const grid=container.querySelector('.rose-grid'),pager=container.querySelector('.rose-pagination');
    const request=defer();env.context.executeApiRequest=()=>request.promise;
    const changing=env.run("showRoseCatalog('mv',2)");await new Promise(resolve=>setTimeout(resolve,210));
    assert.equal(grid.children[0].textContent,'First');assert.equal(pager.parentElement,container);assert.equal(env.run('homeView.page'),1);
    request.reject(new Error('temporary metadata failure'));await changing;
    assert.equal(grid.children[0].textContent,'First');assert.equal(env.run('homeView.page'),1);assert.equal(JSON.parse(env.context.sessionStorage.getItem('roseCatalogState')).page,1);assert.equal(env.run("homeVideos.has('metadata:first')"),true);
    const retry=container.querySelector('.rose-catalog-feedback').children.find(x=>x.tagName==='button');assert.match(retry.textContent,/2/);
    env.context.executeApiRequest=async()=>({list:[{vod_id:'second',vod_name:'Second',source_code:'metadata'}],hasMore:true});
    await retry.onclick();assert.equal(env.run('homeView.page'),2);assert.equal(grid.children[0].textContent,'Second');assert.equal(pager.parentElement,null);assert.equal(container.querySelector('.rose-catalog-feedback'),null);
}
console.log('PASS: failed page request retains the previous results and pagination; retry commits only after success');

// Uncached metadata must not hold the page open or overwrite a later direct jump.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html',search:''};
    env.run(source('ui.js'));env.run(source('rosetv.js'));const container=new env.Element();env.ids.set('douban-recommendations-container',container);
    env.context.homeGeneration=0;env.context.homeVideos=new Map();env.context.homeTrail=[];
    env.context.roseBrowseLimit=()=>16;env.context.initRoseBrowseStyle=()=>{};env.context.renderRoseBrowseNav=()=>{};env.context.roseFilterRows=()=>{};
    env.context.rosePoster=item=>Object.assign(new env.Element('button'),{textContent:item.vod_name});env.context.bridgeReady=Promise.resolve({url:'http://bridge.test'});
    env.context.setTimeout=(fn,ms)=>setTimeout(fn,ms===900?0:ms);
    env.run("homeView={kind:'mv',page:1,limit:16,filterKey:'{}',cursors:[0]}");
    const detail=defer(),requests=[];
    env.context.executeApiRequest=async address=>{const q=new URL(address).searchParams;requests.push({page:q.get('page'),details:q.get('details')});if(q.get('details')==='1')return detail.promise;return {list:[{vod_id:q.get('page'),vod_name:'Page '+q.get('page'),source_code:'metadata'}],hasMore:true,metadataPending:true};};
    await env.run("showRoseCatalog('mv',1)");await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(env.context.isLoadingHomePageItems,false);assert.equal(container.querySelector('.rose-grid').children[0].textContent,'Page 1');
    assert.ok(requests.every(q=>q.details==='0'),'No hidden metadata fetch or next-page prefetch');
    const refresh=container.querySelector('.rose-library-status').children.find(button=>button.tagName==='button');
    const enrichment=refresh.onclick();await tick();assert.ok(requests.some(q=>q.details==='1'));
    await env.run("showRoseCatalog('mv',7)");assert.equal(env.run('homeView.page'),7);assert.equal(container.querySelector('.rose-grid').children[0].textContent,'Page 7');
    env.run('roseResetPosters()');detail.resolve({list:[{vod_id:'1',vod_name:'Page 1',source_code:'metadata',vod_year:'1994',vod_class:'剧情'}]});await enrichment;await tick();await tick();
    assert.equal(env.run('homeView.page'),7);assert.equal(container.querySelector('.rose-grid').children[0].textContent,'Page 7');
}
console.log('PASS: page renders before metadata, direct jump 1 to 7, stale enrichment cannot replace newer results');

// Excluding early versions must preserve sorting, including changing the sort afterward.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html',search:''};
    env.run(source('ui.js'));env.run(source('rosetv.js'));env.context.showRoseCatalog=()=>{};
    env.run("roseFilters.mv={sort:'T'}");const panel=new env.Element();env.context.testPanel=panel;env.run("roseFilterRows('mv',testPanel)");
    const quality=panel.children.at(-1).children[2].children[0];quality.value='clear';quality.onchange();assert.equal(env.run('roseFilters.mv.sort'),'T');
    const second=new env.Element();env.context.testPanel=second;env.run("roseFilterRows('mv',testPanel)");const sort=second.children.at(-1).children[0].children[0];assert.equal(!!sort.disabled,false);
    sort.value='U';sort.onchange();assert.equal(env.run('roseFilters.mv.sort'),'U');assert.equal(env.run('roseFilters.mv.quality'),'clear');
}
console.log('PASS: excluding early versions no longer locks or resets sorting');

// A provided subject ID takes precedence over a newer film with the same name.
{
    let rows=[{...row('old','Same'),vod_year:'2025',vod_douban_id:10},{...row('new','Same'),vod_year:'2026',vod_douban_id:11}];
    const env=environment(async()=>reply(rows));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html',search:''};
    env.run(source('ui.js'));env.run(source('rosetv.js'));
    const found=await env.run("roseFindVideo('fast','Same','',{vod_douban_id:10})");assert.equal(found.vod_id,'old');
    rows=rows.map(item=>({...item,vod_douban_id:0}));env.run('apiCache.clear()');
    assert.equal(await env.run("roseFindVideo('fast','Same','',{vod_douban_id:10})"),null);
}
console.log('PASS: subject identity prevents mismatched remakes and ambiguous unknown-year matches');

// Low-resolution auto selection checks at most two same-film candidates and keeps the matching episode.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/player.html',href:'http://tauri.localhost/player.html',search:'?source_code=original'};
    env.context.API_SITES.original={name:'Original',api:'https://original.test'};
    env.context.currentEpisodeIndex=0;env.context.currentEpisodes=['https://video.test/old.m3u8'];env.context.currentVideoTitle='Film';env.context.playerLoadGeneration=1;
    env.run(source('ui.js'));env.run(source('rosetv.js'));env.context.rosePlayerExtras=()=>{};env.context.showToast=()=>{};
    env.context.dp={video:{videoWidth:864,videoHeight:370}};
    env.context.localStorage.setItem('selectedAPIs','["original","fast","slow"]');
    env.context.sessionStorage.setItem('roseCurrentItem',JSON.stringify({vod_name:'Film',vod_year:2026}));
    env.context.sessionStorage.setItem('roseSelection',JSON.stringify({mode:'auto'}));
    env.context.sessionStorage.setItem('playbackLines',JSON.stringify({groups:[{episodes:[{name:'第02集',url:'https://video.test/old.m3u8'}]}]}));
    let finds=0,probes=0,switched,apiReady=false;
    const sourceInfo=env.context.sourceInfo;env.context.sourceInfo=undefined;
    env.context.roseEnsureAPI=async()=>{apiReady=true;env.context.sourceInfo=sourceInfo;};
    env.context.roseFindVideo=async id=>{finds++;return{...row(id,'Film'),source_code:id};};
    env.context.roseVideoGroups=async item=>({item,groups:[{quality:1,episodes:[{name:'第01集',url:'https://video.test/1.m3u8'},{name:'第2集',url:'https://video.test/'+item.source_code+'.m3u8'}]}]});
    env.context.roseProbeResolution=async url=>{probes++;assert.match(url,/fast|slow/);return url.includes('fast')?{width:640,height:360}:{width:1920,height:800};};
    env.context.selectRosePlayback=(id,name,groups,line)=>{switched={id,index:env.run('roseEpisodeIndex(testGroups)'),line};};
    env.context.testGroups=[{episodes:[{name:'第01集'},{name:'第2集'}]}];
    await env.run('roseCheckResolution()');assert.equal(finds,0,'Playback never starts extra probes automatically');
    await env.run('roseCheckResolution(true)');
    assert.equal(apiReady,true);assert.deepEqual(switched,{id:'slow',index:1,line:0});assert.equal(finds,2);assert.equal(probes,2);
    assert.match(JSON.parse(env.context.sessionStorage.getItem('roseSelection')).reason,/864×370.*1920×800/);
    await env.run('roseCheckResolution()');assert.equal(finds,2,'No repeated probing on control refresh');
    env.context.sessionStorage.setItem('roseSelection',JSON.stringify({mode:'manual'}));env.context.roseQualityAttempt='';await env.run('roseCheckResolution()');assert.equal(finds,2);
    env.context.testGroups=[{episodes:[{name:'第2集纯享'}]}];assert.equal(env.run('roseEpisodeIndex(testGroups)'),-1,'Never switch to an extra edition of the episode');
    env.context.sessionStorage.setItem('roseSelection',JSON.stringify({mode:'auto'}));env.context.roseQualityAttempt='';env.context.localStorage.setItem('selectedAPIs','["original","slow"]');probes=0;
    env.context.roseVideoGroups=async item=>({item,groups:['duplicate','duplicate','backup'].map((name,i)=>({name,episodes:[{name:'第02集',url:'https://video.test/'+i+'.m3u8'}]}))});
    env.context.roseProbeResolution=async url=>{probes++;return url.includes('/2.')?{width:1920,height:1080}:null;};
    await env.run('roseCheckResolution(true)');assert.equal(probes,2);assert.equal(switched.line,2,'Try a different line instead of a duplicate label');
}
console.log('PASS: bounded measured-quality upgrade, matching episode, no repeated or manual-source probing');

// Temporary probe decoders release video resources and HLS on success, error and navigation abort.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/player.html',href:'http://tauri.localhost/player.html',search:''};
    env.run(source('ui.js'));env.run(source('rosetv.js'));
    let video,destroys=0,loads=0;
    const create=env.context.document.createElement;
    env.context.document.createElement=tag=>{
        if(tag!=='video')return create(tag);
        const events=new Map();video={videoWidth:0,videoHeight:0,readyState:2,events,addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name),pause(){},removeAttribute(){},load(){loads++;}};return video;
    };
    class Hls {static Events={ERROR:'error'};static isSupported(){return true;}on(name,fn){this.error=fn;}loadSource(){}attachMedia(){}destroy(){destroys++;}}
    env.context.Hls=Hls;const signal=new AbortController();env.context.probeSignal=signal.signal;
    const success=env.run("roseProbeResolution('http://127.0.0.1:34771/stream/line/0',probeSignal)");video.videoWidth=1920;video.videoHeight=1080;video.events.get('loadedmetadata')();assert.equal((await success).width,1920);assert.equal(video.events.size,0);
    const aborted=env.run("roseProbeResolution('https://video.test/b.m3u8',probeSignal)");signal.abort();assert.equal(await aborted,null);assert.equal(video.events.size,0);
    env.context.probeSignal=new AbortController().signal;const failed=env.run("roseProbeResolution('https://video.test/c.m3u8',probeSignal)");video.events.get('error')();assert.equal(await failed,null);
    assert.equal(destroys,3);assert.equal(loads,3);assert.equal(video.events.size,0);
}
console.log('PASS: temporary quality-probe decoder cleanup on success, failure and cancellation');

// Cover recovery is visible-only, bounded to two public-source lookups and drops stale work.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html',search:''};
    env.run(source('ui.js'));env.run(source('rosetv.js'));env.context.API_SITES.fast={name:'Public',api:'https://360zy.com'};
    env.context.localStorage.setItem('selectedAPIs','["site","fast"]');
    const waits=[];env.context.roseFindVideo=(id,title,year,reference)=>{assert.equal(id,'fast');assert.ok(reference.vod_douban_id);const wait=defer();waits.push(wait);return wait.promise;};
    const parents=[];
    const images=Array.from({length:3},(_,i)=>{const image=new env.Element('img'),card={isConnected:true,parentElement:new env.Element()};parents.push(card.parentElement);image.closest=()=>card;env.context.item={vod_name:'Film '+i,vod_douban_id:i+1};env.context.image=image;env.run('roseRecoverPoster(item,image)');return image;});
    await tick();assert.equal(waits.length,0,'Missing posters never trigger source searches without a click');
    for(const parent of parents)parent.children[0].onclick({preventDefault(){},stopPropagation(){}});
    await tick();assert.equal(waits.length,2);assert.equal(env.run('rosePosterActive'),2);
    env.run('roseResetPosters()');waits.forEach(wait=>wait.resolve({vod_pic:'https://images.test/poster.jpg'}));await tick();
    assert.equal(waits.length,2);assert.equal(env.run('rosePosterActive'),0);assert.ok(images.every(image=>!image.src));
    const image=new env.Element('img'),parent=new env.Element();image.closest=()=>({isConnected:true,parentElement:parent});env.context.image=image;env.run('roseRecoverPoster(item,image)');parent.children[0].onclick({preventDefault(){},stopPropagation(){}});await tick();
    waits.at(-1).resolve({vod_pic:'https://images.test/poster.jpg'});await tick();assert.equal(image.src,'https://images.test/poster.jpg');
}
console.log('PASS: bounded public cover recovery, no account-site lookup, stale queue cleanup');

{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html',search:''};
    env.context.sessionStorage.setItem('roseFilters',JSON.stringify({mv:{genre:'科幻',sort:'T'}}));env.run(source('ui.js'));env.run(source('rosetv.js'));
    assert.equal(env.run('roseFilters.mv.sort'),'S');
    const panel=new env.Element();env.context.testPanel=panel;env.run("roseFilterRows('mv',testPanel)");
    const options=panel.children.at(-1).children[0].children[0].children;
    assert.equal(options.find(option=>option.textContent==='评分最高').value,'S');
}
console.log('PASS: real score-sort parameter and migration of previously saved score filters');

// Multiple logical tabs keep separate metadata, episodes, rates and positions while sharing one iframe.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html',search:''};
    env.context.document.body=new env.Element('body');env.context.scrollTo=()=>{};
    env.run(source('ui.js'));env.run(source('rosetv.js'));env.context.renderRoseBrowseNav=()=>{};env.context.navigateToTab=()=>{};
    const state=(title,position,rate)=>({title,url:'http://tauri.localhost/player.html?title='+title+'&position='+position+'&url=https://video.test/'+title+'.m3u8',item:{vod_name:title,vod_douban_id:title==='A'?1:2},session:{roseCurrentItem:JSON.stringify({vod_name:title}),playbackLines:JSON.stringify({title,sourceCode:title}),roseSelection:JSON.stringify({mode:'manual'})},episodes:['https://video.test/'+title+'.m3u8'],reversed:false,rate,playing:false});
    let current=state('A',45,1.5),pauses=0;
    env.context.sessionStorage.setItem('roseCurrentItem',JSON.stringify(current.item));env.run("roseStartPlayer('player.html?title=A&url=https://video.test/A.m3u8')");
    const frame=env.ids.get('rosePlayerFrame');frame.remove=()=>env.ids.delete('rosePlayerFrame');frame.contentWindow={rosePlaybackSnapshot:()=>current,rosePauseForBrowse(){pauses++;return false;},roseResumeFromBrowse(){},focus(){}};frame.dataset.roseLoading='';
    env.run('roseSavePlayerTab()');env.context.sessionStorage.setItem('roseCurrentItem',JSON.stringify({vod_name:'B',vod_douban_id:2}));env.run("roseStartPlayer('player.html?title=B&url=https://video.test/B.m3u8')");
    current=state('B',125,2);frame.dataset.roseLoading='';env.run('roseShowPlayer(1)');
    assert.equal(env.run('rosePlayerTabs.length'),2);assert.equal(env.ids.get('rosePlayerFrame'),frame);assert.equal(JSON.parse(env.context.sessionStorage.getItem('playbackLines')).title,'A');
    assert.equal(new URL(frame.src).searchParams.get('position'),'45');assert.equal(new URL(frame.src).searchParams.get('rate'),'1.5');assert.equal(new URL(frame.src).searchParams.get('resume'),'0');
    assert.equal(env.run('rosePlayerTabs[1].state.rate'),2);assert.equal(env.run('rosePlayerTabs[1].state.session.playbackLines'),JSON.stringify({title:'B',sourceCode:'B'}));
    env.run('roseClosePlayer(2)');assert.equal(env.run('roseActivePlayerTab'),1);assert.equal(env.run('rosePlayerTabs.length'),1);assert.equal(env.ids.get('rosePlayerFrame'),frame);
    env.run('roseClosePlayer(1)');assert.equal(env.run('rosePlayerTabs.length'),0);assert.equal(env.ids.has('rosePlayerFrame'),false);assert.ok(pauses>0);
}
console.log('PASS: multiple independent movie tabs, single live iframe, inactive close and progress/rate restoration');

{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html',search:''};
    const properties={};env.context.document.documentElement={dataset:{},style:{setProperty:(key,value)=>properties[key]=value}};const media={matches:false,addEventListener(_,listener){this.change=listener;}};env.context.matchMedia=()=>media;
    env.run(source('ui.js'));env.run(source('rosetv.js'));assert.equal(env.context.document.documentElement.dataset.roseTheme,'light');
    env.run("roseSetTheme('dark','#278866')");assert.equal(env.context.document.documentElement.dataset.roseTheme,'dark');assert.equal(properties['--rose-accent'],'#278866');
    env.run("roseSetTheme('system')");media.matches=true;media.change();assert.equal(env.context.document.documentElement.dataset.roseTheme,'dark');media.matches=false;media.change();assert.equal(env.context.document.documentElement.dataset.roseTheme,'light');
    env.run("roseSetTheme(null,'invalid')");assert.equal(properties['--rose-accent'],'#278866');assert.equal(env.context.localStorage.getItem('roseTheme'),'system');
}
console.log('PASS: persistent light/dark/system modes, accent colors and system appearance changes');

// Input suggestions ignore stale replies and IME composition; keyboard selection submits the title.
{
    const requests=[];const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',search:''};
    env.run(source('ui.js'));env.run(source('rosetv.js'));env.context.bridgeReady=Promise.resolve({url:'http://bridge.test'});
    env.context.executeApiRequest=address=>{const pending=defer();requests.push({address,pending});return pending.promise;};
    const input=new env.Element('input'),form=new env.Element('form');form.append(input);input.isConnected=true;
    env.context.input=input;env.context.form=form;env.run('roseBindSuggestions(input,form)');const list=form.children[1];
    input.value='生';input.oninput();await new Promise(resolve=>setTimeout(resolve,820));
    input.value='生化';input.oninput();await new Promise(resolve=>setTimeout(resolve,820));
    requests[0].pending.resolve({list:[{title:'stale',year:'2000'}]});await tick();assert.equal(list.hidden,true);
    requests[1].pending.resolve({list:[{title:'生化危机',year:'2002'},{title:'生化危机2',year:'2004'}]});await tick();assert.equal(list.hidden,false);assert.equal(list.children.length,2);
    let selected;env.context.roseSubmitSearch=title=>{selected=title;};input.onkeydown({key:'ArrowDown',preventDefault(){}});input.onkeydown({key:'Enter',preventDefault(){}});assert.equal(selected,'生化危机');assert.equal(list.hidden,true);
    input.dispatchEvent({type:'compositionstart'});input.value='中文输入中';input.oninput();await new Promise(resolve=>setTimeout(resolve,320));assert.equal(requests.length,2);
    input.dispatchEvent({type:'compositionend'});input.onkeydown({key:'Escape'});
}
console.log('PASS: debounced search suggestions, stale results, IME input and keyboard selection');

// Playback metadata is reused by cards without confusing identical titles from different years.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',search:''};env.run(source('ui.js'));env.run(source('rosetv.js'));
    env.run("roseRememberMetadata({vod_name:'Same',vod_year:'2026',vod_area:'美国',vod_class:'惊悚 / 恐怖'})");
    const current=env.run("let item={vod_name:'Same',vod_year:'2026'};roseUseMetadata(item);item");assert.equal(current.vod_area,'美国');assert.equal(current.vod_class,'惊悚 / 恐怖');
    const old=env.run("let remake={vod_name:'Same',vod_year:'2002'};roseUseMetadata(remake);remake");assert.equal(old.vod_class,undefined);
}
console.log('PASS: shared playback/card metadata cache preserves remake identity');

// Previously saved public sources migrate without losing historical source aliases.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',search:''};
    env.context.API_SITES.zy360={name:'360',api:'https://360zy.com'};
    env.context.localStorage.setItem('customAPIs',JSON.stringify([{name:'360',url:'https://www.360zy.com/'},{name:'Extra',url:'https://extra.test'}]));
    env.context.localStorage.setItem('selectedAPIs','["custom_0","custom_1","rose_hn","site"]');
    env.run(source('ui.js'));env.run(source('rosetv.js'));
    assert.deepEqual(JSON.parse(env.context.localStorage.getItem('selectedAPIs')),['zy360','rose_public_1','rose_hn','site']);
    assert.equal(JSON.parse(env.context.localStorage.getItem('customAPIs')).length,2);
    assert.equal(env.context.API_SITES.rose_hn.name,'红牛资源');
    env.context.localStorage.setItem('customAPIs',JSON.stringify([{name:'360',url:'https://www.360zy.com/'}]));env.run('rosePrepareSources()');
    assert.equal(env.context.API_SITES.rose_public_1,undefined);assert.ok(!JSON.parse(env.context.localStorage.getItem('selectedAPIs')).includes('rose_public_1'),'Deleted custom sources cannot keep issuing requests');
}
console.log('PASS: public source migration, Red Bull builtin and retained history aliases');

// Only decoded samples rank for automatic selection; preserve the account source.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',search:''};env.context.Hls={};
    env.context.API_SITES=Object.fromEntries(Array.from({length:7},(_,i)=>['s'+i,{name:'Source '+i,api:'https://s'+i+'.test'}]));
    env.context.API_SITES.site={name:'Account',api:'http://127.0.0.1'};
    env.context.localStorage.setItem('roseSourcesAdded','1');env.context.localStorage.setItem('selectedAPIs','["site"]');
    env.run(source('ui.js'));env.run(source('rosetv.js'));
    delete env.context.API_SITES.rose_hn;
    env.context.roseSourceSamples=async()=>Array.from({length:5},(_,i)=>({kind:String(i),label:String(i),item:{vod_name:'Film'+i,vod_year:2019}}));
    env.context.roseFindVideo=async(id,title,year,reference,report)=>{report({list:[]});return row(id+'.test',title);};
    env.context.roseVideoGroups=async item=>({groups:[{episodes:[{url:item.vod_id}]}]});
    env.context.roseProbeResolution=async address=>address.startsWith('s6.')?null:{width:1920,height:1080,elapsedMs:100+Number(address[1])*200};
    env.context.initAPICheckboxes=()=>{};env.context.updateSelectedApiCount=()=>{};
    const results=await env.run('roseRunSourceTests()');
    const chosen=JSON.parse(env.context.localStorage.getItem('selectedAPIs'));
    assert.deepEqual(chosen,['site','s0','s1','s2','s3','s4']);assert.equal(results.s6.apiAvailable,true);assert.equal(results.s6.playable,false);assert.equal(env.context.roseSourceTestController,null);
    assert.equal(results.s0.samples.length,5);assert.equal(results.s0.passed,5);assert.equal(results.s6.passed,0);
    const before=env.context.localStorage.getItem('selectedAPIs');
    env.context.roseProbeResolution=async()=>{env.context.roseSourceTestController.abort();return null;};
    await env.run('roseRunSourceTests()');assert.equal(env.context.localStorage.getItem('selectedAPIs'),before);
}
console.log('PASS: actual-decode scoring, top five selection, custom-source preservation and cancellation');

{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',search:''};
    env.context.DOMParser=class{parseFromString(value){return{body:{textContent:value}};}};
    env.run(source('ui.js'));env.run(source('rosetv.js'));
    const early={...row('early','Film'),vod_remarks:'TC抢先版',source_code:'fast'};env.context.early=early;
    await assert.rejects(env.run('roseVideoGroups(early)'),/抢先/);
    assert.equal((await env.run('roseVideoGroups(early,true)')).groups[0].quality,-1);
    env.context.downloadPanel=new env.Element();
    env.run("roseRenderMovieInfo(downloadPanel,{vod_name:'Film',source_code:'fast',vod_down_url:'First$magnet:?xt=urn:btih:abc'})");
    const downloads=env.context.downloadPanel.children.find(e=>e.className==='rose-downloads');
    const group=downloads.children.find(e=>e.tagName==='details');assert.equal(!!group.open,false);assert.equal(group.children[1].children.length,0);
    env.context.localStorage.setItem('rosePreferredSource','slow');assert.equal(env.run('rosePreferredID()'),'auto');
}
console.log('PASS: movie-wide TC annotations, default collapsed downloads and automatic-only default policy');

// A poster has two sibling buttons: bookmarking never starts playback or issues a request.
{
    const env=environment(async()=>{throw new Error('Bookmark must remain local');});
    env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html',search:''};
    env.run(source('ui.js'));let played=0;
    env.context.rosePoster=()=>{const button=new env.Element('button');button.className='rose-poster';button.append(new env.Element('p'));return button;};
    env.run(source('rosetv.js'));env.context.onPlay=()=>{played++;};
    const card=env.run("rosePoster({vod_name:'Film',vod_year:'2000',vod_douban_id:42},onPlay)");
    const button=card.children.find(child=>child.className.includes('rose-card-favorite'));
    env.context.document.querySelectorAll=selector=>selector==='.rose-card-favorite'?[button]:[];
    let prevented=0,stopped=0;button.onclick({preventDefault(){prevented++;},stopPropagation(){stopped++;}});
    assert.equal(played,0);assert.equal(prevented,1);assert.equal(stopped,1);assert.equal(button.getAttribute('aria-pressed'),'true');
    assert.equal(JSON.parse(env.context.localStorage.getItem('roseFavorites'))[0].vod_douban_id,42);
    button.onclick({preventDefault(){},stopPropagation(){}});assert.equal(button.getAttribute('aria-pressed'),'false');
    assert.equal(JSON.parse(env.context.localStorage.getItem('roseFavorites')).length,0);
    assert.equal(card.children[0].tagName,'button');assert.equal(card.children[1].tagName,'button');
    assert.equal(card.children[0].className,'rose-poster','The original poster styling must remain on the playback button');
}
console.log('PASS: separate poster star toggles bounded local favorites without starting playback');

// PiP returns with the user's play/pause intent; an active stream is not restarted.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/player.html',href:'http://tauri.localhost/player.html',search:''};
    env.run(source('ui.js'));env.run(source('rosetv.js'));
    const controls=new env.Element('div'),video=new EventTarget();video.readyState=4;video.paused=false;video.currentTime=90;video.isConnected=true;
    let starts=0,plays=0,returned;video.play=()=>{plays++;video.paused=false;return Promise.resolve();};
    const player={video,container:{querySelector:()=>controls},on(){},options:{video:{url:'https://video.test/movie.m3u8'}}};
    env.context.dp=player;env.context.currentHls={levels:[{}],startLoad(){starts++;}};
    env.run('roseResumeFromBrowse(false)');assert.equal(starts,0,'PiP return must reuse the current streaming session');
    env.run('window.roseBrowsing=true;roseResumeFromBrowse(true)');assert.equal(starts,1);assert.equal(plays,1);
    env.context.parent={roseShowPlayer(){returned=this.roseResumePlayback;}};env.run('window.roseEmbedded=true;roseBindPlayerWindows(dp)');
    env.context.document.pictureInPictureElement=video;video.dispatchEvent(new Event('enterpictureinpicture'));
    env.context.document.pictureInPictureElement=null;video.paused=true;video.dispatchEvent(new Event('pause'));video.dispatchEvent(new Event('leavepictureinpicture'));await tick();
    assert.equal(returned,true,'Native return pauses must not discard the previous playing state');
    video.paused=false;env.context.document.pictureInPictureElement=video;video.dispatchEvent(new Event('enterpictureinpicture'));
    video.paused=true;video.dispatchEvent(new Event('pause'));await tick();env.context.document.pictureInPictureElement=null;video.dispatchEvent(new Event('leavepictureinpicture'));
    assert.equal(returned,false,'A deliberate pause inside PiP must remain paused');
    const icon=env.run("roseIcon('pip')");assert.equal(icon.children.at(-1).tagName,'rect');assert.equal(icon.children.at(-1).getAttribute('width'),10);
}
console.log('PASS: PiP play/pause intent, current-stream reuse and standard Lucide icon geometry');

// A cancelled subscriber must not cancel a shared request still needed by another view.
{
    const env=environment(async()=>reply([]));const requests=[];
    env.context.ROSETV_BRIDGE={enabled:true,url:'http://bridge.test',key:'test'};
    env.context.fetch=(address,options)=>new Promise((resolve,reject)=>{
        const record={address,options,resolve:value=>resolve({ok:true,text:async()=>JSON.stringify(value)})};requests.push(record);
        options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'})),{once:true});
    });
    env.context.firstController=new AbortController();env.context.nextController=new AbortController();
    const first=env.run("executeApiRequest('https://source.test/shared',{signal:firstController.signal})");
    const second=env.run("executeApiRequest('https://source.test/shared',{signal:nextController.signal})");
    env.context.firstController.abort();await assert.rejects(first,{name:'AbortError'});
    assert.equal(requests.length,1);assert.equal(requests[0].options.signal.aborted,false);
    requests[0].resolve({list:[row('shared')]});await second;
    assert.equal((await env.run("executeApiRequest('https://source.test/shared')")).list.length,1);assert.equal(requests.length,1);
    env.context.firstController=new AbortController();
    const cancelled=env.run("executeApiRequest('https://source.test/replace',{signal:firstController.signal})");
    env.context.firstController.abort();await assert.rejects(cancelled,{name:'AbortError'});
    const replacement=env.run("executeApiRequest('https://source.test/replace')");await tick();
    assert.equal(env.run('apiPending.size'),1,'Old cleanup cannot delete a newer request');
    requests.at(-1).resolve({list:[]});await replacement;assert.equal(env.run('apiPending.size'),0);
}
console.log('PASS: real fetch cancellation, shared subscribers, retry ownership and reusable successful results');

// A page of cards writes stable metadata once, then revisits do no synchronous writes.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',search:''};env.run(source('ui.js'));env.run(source('rosetv.js'));
    let writes=0;const set=env.context.localStorage.setItem;env.context.localStorage.setItem=(key,value)=>{if(key==='roseMovieMetadata')writes++;set(key,value);};
    for(let i=0;i<16;i++)env.run("roseRememberMetadata({vod_name:'Film "+i+"',vod_douban_id:"+(i+1)+",vod_year:'2026',vod_class:'剧情',vod_area:'美国'})");
    assert.equal(writes,0);env.run('roseFlushMetadata()');assert.equal(writes,1);
    for(let i=0;i<16;i++)env.run("roseRememberMetadata({vod_name:'Film "+i+"',vod_douban_id:"+(i+1)+",vod_year:'2026',vod_class:'剧情',vod_area:'美国'})");
    await new Promise(resolve=>setTimeout(resolve,10));assert.equal(writes,1);
}
console.log('PASS: one metadata write per page, zero unchanged-card writes on revisits');

// The homepage loads its movie section first; other sections enter through visibility or a click.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',href:'http://tauri.localhost/index.html',search:''};
    const container=new env.Element();container.id='douban-recommendations-container';
    env.run(source('ui.js'));env.run(source('rosetv.js'));env.context.homeView={kind:'home'};env.context.homeTrail=[];env.context.homeGeneration=0;env.context.homeVideos=new Map();env.context.roseBrowseLimit=()=>16;env.context.initRoseBrowseStyle=()=>{};env.context.renderRoseBrowseNav=()=>{};
    env.context.bridgeReady=Promise.resolve({url:'http://bridge.test'});const requests=[];
    env.context.executeApiRequest=async address=>{requests.push(address);return{list:[]};};
    await env.run('roseHome(false)');assert.equal(requests.length,1);assert.match(requests[0],/kind=mv/);assert.ok(!requests[0].includes('/home?'));
    const tv=container.children[1].children[1].children[0];tv.onclick();await tick();assert.equal(requests.length,2);assert.match(requests[1],/kind=tv/);
    env.run('roseStopBrowse()');
}
console.log('PASS: homepage starts with one section and retains explicit-load fallback without hidden account scans');

{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',search:''};env.run(source('ui.js'));env.run(source('rosetv.js'));
    const rows=Object.fromEntries(Array.from({length:600},(_,i)=>['douban:'+i,{time:Date.now(),fields:{vod_name:'Film '+i,vod_class:'剧'.repeat(300),vod_area:'国'.repeat(300),vod_actor:'人'.repeat(300)}}]));
    env.context.largeMetadata=rows;env.run('roseMetadataCache=largeMetadata;roseMetadataDirty=true');const start=Date.now();env.run('roseFlushMetadata()');
    assert.ok(env.context.localStorage.getItem('roseMovieMetadata').length*2<=512*1024);assert.ok(Date.now()-start<250,'Evict records without repeatedly serializing the entire cache');
    assert.ok(Object.keys(JSON.parse(env.context.localStorage.getItem('roseMovieMetadata'))).length<=600);
}
console.log('PASS: near-capacity metadata eviction stays bounded in time and storage');

{
    const pending=[];const env=environment((_,{options})=>{const task=defer();pending.push(task);return task.promise;});
    env.context.API_SITES.third={name:'Third',api:'https://third.test'};env.context.selectedAPIs=['fast','slow','third'];env.ids.get('searchInput').value='stopped';
    const search=env.run('search()');await tick();assert.equal(pending.length,2);
    env.run('cancelSearchLoad()');pending.forEach(task=>task.resolve(reply([])));await search;assert.equal(pending.length,2,'Leaving search prevents queued sources from starting');
}
console.log('PASS: search has two workers and leaving the page drops queued sources');

{
    let calls=0;const env=environment(async()=>{calls++;return reply([]);});
    for(const id of ['page-home','douban-recommendations-container']){const el=new env.Element();el.id=id;}
    env.context.roseIcon=()=>new env.Element('svg');env.context.scrollTo=()=>{};
    const ready=defer();env.context.bridgeReady=ready.promise;
    const logic=source('douban_logic.js');env.run(logic.slice(logic.indexOf('window.homeVideos = new Map();'),logic.indexOf('function initDouban(')));
    const early=env.run("showRoseCatalog('home',1)");env.context.roseRefreshHome=()=>{};ready.resolve({enabled:true,site:true,url:'http://bridge.test'});await early;
    assert.equal(calls,0,'Legacy startup must hand off without fetching the account homepage');
}
console.log('PASS: old startup loader cannot request hidden account-site recommendations');

// Local pacing waits once, while website refusals are never automatically retried.
{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',search:''};env.run(source('ui.js'));env.run(source('rosetv.js'));
    const status=new env.Element(),controller=new AbortController();let calls=0;
    env.context.status=status;env.context.budgetSignal=controller.signal;
    env.context.executeApiRequest=async()=>{if(++calls===1)throw Object.assign(new Error('local wait'),{code:'local_budget',retryAfterSeconds:.01});return{list:[]};};
    const wait=env.run("roseCatalogRequest('http://bridge.test/library',{signal:budgetSignal},status,true)");await tick();
    assert.match(status.textContent,/自动继续/);assert.match(status.textContent,/上次/);assert.equal(calls,1);
    await wait;assert.equal(calls,2);
    calls=0;env.context.executeApiRequest=async()=>{calls++;throw new Error('website verification');};
    await assert.rejects(env.run("roseCatalogRequest('http://bridge.test/library',{signal:budgetSignal},status)"),/website verification/);assert.equal(calls,1);
    env.context.executeApiRequest=async()=>{throw Object.assign(new Error('local wait'),{code:'local_budget',retryAfterSeconds:30});};
    const stopped=env.run("roseCatalogRequest('http://bridge.test/library',{signal:budgetSignal},status)");await tick();controller.abort();await assert.rejects(stopped,{name:'AbortError'});
}
console.log('PASS: local quota resumes automatically, navigation cancels waiting, website verification never auto-retries');

// Two prefetched pages share the foreground cache and never recursively prefetch.
{
    let calls=0;const env=environment(async()=>{calls++;return reply([{vod_id:'one'}]);});env.context.location={pathname:'/index.html',search:''};env.run(source('ui.js'));env.run(source('rosetv.js'));
    env.context.ROSETV_BRIDGE={url:'http://bridge.test',enabled:true,key:'test'};
    env.context.setTimeout=(fn,ms)=>setTimeout(fn,ms===250?0:ms);env.context.prefetchSignal=new AbortController().signal;
    env.run("rosePrefetchNext('http://bridge.test/library?kind=mv&page=1',{hasMore:true},prefetchSignal)");await new Promise(resolve=>setTimeout(resolve,15));
    assert.equal(calls,2);await env.run("executeApiRequest('http://bridge.test/library?kind=mv&page=2')");await env.run("executeApiRequest('http://bridge.test/library?kind=mv&page=3')");assert.equal(calls,2);
    env.run("rosePrefetchNext('http://bridge.test/library?kind=mv&page=2',{hasMore:true,nextCursor:20},prefetchSignal)");await tick();assert.equal(calls,2);
    const controller=new AbortController();env.context.prefetchSignal=controller.signal;
    env.run("rosePrefetchNext('http://bridge.test/library?kind=mv&page=4',{hasMore:true},prefetchSignal)");controller.abort();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,2);
    env.run('roseStopBrowse()');
}
console.log('PASS: two-page prefetch reuses the normal cache, stops on navigation and skips source-scanning cursors');

{
    const env=environment(async()=>({status:429,body:JSON.stringify({error:'local wait',code:'local_budget',retryAfterSeconds:18})}));
    env.context.ROSETV_BRIDGE={url:'http://bridge.test',enabled:true,key:'test'};
    await assert.rejects(env.run("executeApiRequest('http://bridge.test/library')"),error=>error.code==='local_budget'&&error.retryAfterSeconds===18);
    await assert.rejects(env.run("executeApiRequest('https://source.test/api')"),error=>error.code===undefined);
}
console.log('PASS: structured local waiting survives transport; public-source errors cannot trigger local automatic retries');

{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',search:''};env.run(source('ui.js'));env.run(source('rosetv.js'));
    const container=new env.Element();env.ids.set('douban-recommendations-container',container);env.context.homeGeneration=0;env.context.homeVideos=new Map();env.context.homeTrail=[];env.context.roseBrowseLimit=()=>16;env.context.initRoseBrowseStyle=()=>{};env.context.renderRoseBrowseNav=()=>{};
    env.context.bridgeReady=Promise.resolve({url:'http://bridge.test'});let observer,active=0,peak=0;const calls=[];
    env.context.IntersectionObserver=class{constructor(callback){observer=this;this.callback=callback;}observe(){}disconnect(){this.closed=true;}};
    env.context.executeApiRequest=async address=>{calls.push(new URL(address).searchParams.get('kind'));active++;peak=Math.max(peak,active);await tick();active--;return{list:[]};};
    await env.run('roseHome(false)');assert.deepEqual(calls,['mv']);
    observer.callback([{target:container.children[3],isIntersecting:true},{target:container.children[4],isIntersecting:true}]);await tick();await tick();await tick();await tick();
    assert.deepEqual(calls,['mv','variety','doc']);assert.equal(peak,1);assert.ok(!calls.includes('tv')&&!calls.includes('ac'));
    observer.callback([{target:container.children[3],isIntersecting:true}]);await tick();assert.equal(calls.length,3,'Unchanged visible sections use cached results, including empty lists');
    env.run('roseStopBrowse()');assert.equal(observer.closed,true);
}
console.log('PASS: visible homepage sections load serially and reuse cached results without fetching offscreen sections');

{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',search:''};env.run(source('ui.js'));env.run(source('rosetv.js'));
    let active=0,peak=0,calls=0;const policies=[];
    env.context.fetch=async(address,options)=>{calls++;active++;peak=Math.max(peak,active);policies.push(options);await tick();active--;return{ok:true,arrayBuffer:async()=>new ArrayBuffer(0)};};
    env.context.posters=Array.from({length:32},(_,i)=>({vod_pic:'https://poster.test/'+i}));env.context.posterSignal=new AbortController().signal;
    await env.run('roseWarmPosters(posters,posterSignal)');assert.equal(calls,32);assert.equal(peak,1);assert.ok(policies.every(p=>p.cache==='force-cache'&&p.priority==='low'));
    const controller=new AbortController();controller.abort();env.context.posterSignal=controller.signal;await env.run('roseWarmPosters(posters,posterSignal)');assert.equal(calls,32);
}
console.log('PASS: upcoming posters warm the browser cache with one low-priority worker and stop on cancellation');

{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',search:''};env.run(source('ui.js'));env.run(source('rosetv.js'));
    const requests=[],revoked=[];let serial=0;
    env.context.URL=class extends URL {};
    env.context.URL.createObjectURL=()=>`blob:poster-${++serial}`;env.context.URL.revokeObjectURL=value=>revoked.push(value);
    env.context.fetch=(address,options)=>new Promise((resolve,reject)=>{requests.push({address,options,resolve});options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'})),{once:true});});
    env.context.images=Array.from({length:16},()=>new env.Element('img'));
    env.run("images.forEach((image,i)=>roseLoadPoster(image,'https://poster.test/old/'+i))");
    assert.equal(requests.length,4,'Only four foreground posters may download at once');
    env.run('roseResetPosters()');await tick();
    assert.ok(requests.every(row=>row.options.signal.aborted));assert.equal(requests.length,4,'Old queued posters must never start');
    env.run("roseLoadPoster(images[0],'https://poster.test/new')");await tick();
    requests[4].resolve({ok:true,blob:async()=>({})});await tick();await tick();
    assert.equal(env.context.images[0].src,'blob:poster-1');assert.equal(requests[4].options.priority,'high');
    env.run('roseResetPosters()');assert.deepEqual(revoked,['blob:poster-1']);assert.equal(env.run('roseImageActive'),0);
}
console.log('PASS: four foreground poster workers cancel old pages, release slots and revoke blob URLs');

{
    const env=environment(async()=>reply([]));env.context.ROSETV_BRIDGE={url:'http://bridge.test',enabled:true,key:'test'};const requests=[];
    env.context.fetch=(address,options)=>new Promise((resolve,reject)=>{requests.push({address,options,resolve});options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true});});
    const background=env.run("executeApiRequest('http://bridge.test/library?page=9&prefetch=1')").catch(error=>error.name);await tick();
    const foreground=env.run("executeApiRequest('http://bridge.test/library?page=9')");await tick();
    assert.equal(requests.length,2);assert.equal(requests[0].options.signal.aborted,true);assert.equal(requests[1].options.priority,'high');
    requests[1].resolve({ok:true,text:async()=>JSON.stringify({list:[]})});await foreground;await background;
    await env.run("executeApiRequest('http://bridge.test/library?page=9')");assert.equal(requests.length,2);
}
console.log('PASS: clicking a queued prefetched page upgrades to foreground priority without inheriting background quota limits');

{
    const env=environment(async()=>reply([]));env.run(source('config_io.js'));let imported,saved;
    env.context.PLAYER_CONFIG={adFilteringStorage:'adFilteringEnabled'};env.context.SEARCH_HISTORY_KEY='searchHistory';
    env.context.sha256=async value=>createHash('sha256').update(value).digest('hex');
    env.context.saveStringAsFile=(text,name)=>saved={data:JSON.parse(text),name};
    env.context.localStorage.setItem('roseFavorites','[{"vod_name":"Saved"}]');await env.run('exportConfig()');
    assert.equal(saved.data.name,'RoseTV-Settings');assert.ok(saved.data.data.roseFavorites);assert.ok(saved.name.startsWith('RoseTV-Settings_'));
    env.context.showImportBox=callback=>imported=callback;env.context.FileReader=class{readAsText(file){this.result=file.text;this.onload();}};
    env.context.setTimeout=()=>0;await env.run('importConfig()');
    const data={roseFavorites:'[{"vod_name":"Restored"}]'},old={name:'PreviousProduct-Settings',cfgVer:'1.0.0',data,hash:await env.context.sha256(JSON.stringify(data))};
    await imported({type:'application/json',name:'settings.json',size:200,text:JSON.stringify(old)});assert.equal(env.context.localStorage.getItem('roseFavorites'),data.roseFavorites);
    old.data={roseFavorites:{bad:true}};old.hash=await env.context.sha256(JSON.stringify(old.data));await imported({type:'application/json',name:'settings.json',size:200,text:JSON.stringify(old)});
    assert.equal(env.context.localStorage.getItem('roseFavorites'),data.roseFavorites,'Malformed settings cannot overwrite saved favorites');
}
console.log('PASS: Rose exports include favorites, valid older formats import, malformed settings preserve data');

{
    const env=environment(async()=>reply([]));env.context.location={pathname:'/index.html',search:''};env.run(source('ui.js'));env.run(source('rosetv.js'));
    env.context.executeApiRequest=()=>{throw new Error('Sample selection must not request a website');};
    const items=await env.run('roseSourceSamples(new AbortController().signal)');assert.equal(items.length,5);assert.equal(new Set(items.map(row=>row.kind)).size,5);
    env.context.localStorage.setItem('roseSourceTests',JSON.stringify({fast:{score:10},slow:{score:80}}));const called=[];
    env.context.roseFindVideo=async id=>{called.push(id);return {source_code:id};};env.context.roseVideoGroups=async()=>({groups:[]});
    await env.run("roseFindPlayable(['fast','slow'],{vod_name:'Film'},false,new AbortController().signal)");assert.equal(called[0],'slow');
}
console.log('PASS: representative samples need no metadata requests; automatic matching prefers measured source quality');

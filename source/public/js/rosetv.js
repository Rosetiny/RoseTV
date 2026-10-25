/* Cancellable pooled transport, shared with the small embedded API shim. */
document.title='RoseTV';
(() => {
const apiRequestKey = (url, options = {}) => {const parsed=new URL(url);if(parsed.origin===window.ROSETV_BRIDGE?.url&&['/library','/suggest','/catalog','/home'].includes(parsed.pathname)){parsed.searchParams.delete('prefetch');parsed.searchParams.sort();}return JSON.stringify([options.method || 'GET', parsed.href, options.headers || {}, !!options.asText]);};
window.cachedApiRequest = function(url, options = {}) {
    const value = apiCache.get(apiRequestKey(url, options));
    return value && Date.now() - value.time < 300000 ? value.data : undefined;
}
function waitForApiRequest(entry, signal) {
    entry.users++;
    let abort;
    const cancelled = new Promise((_, reject) => {
        abort = () => reject(Object.assign(new Error('已取消加载'), { name: 'AbortError' }));
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
    return Promise.race([entry.promise, cancelled]).finally(() => {
        signal?.removeEventListener('abort', abort);
        if (!--entry.users) entry.controller.abort();
    });
}
window.roseExecuteApiRequest = async function(apiUrl, options = {}) {
    const { method = 'GET', headers = {}, timeoutSecs = 6, asText = false, signal } = options;
    if (signal?.aborted) throw Object.assign(new Error('已取消加载'), { name: 'AbortError' });
    const parsed = new URL(apiUrl);
    if(parsed.hostname==='www.hongniuzy2.com'&&parsed.searchParams.get('ac')==='videolist'){parsed.searchParams.set('ac','detail');apiUrl=parsed.href;}
    if (!/^https?:$/.test(new URL(apiUrl).protocol)) throw new Error('无效的资源地址');
    const key = apiRequestKey(apiUrl, options);
    const cached = cachedApiRequest(apiUrl, options);
    if (method === 'GET' && cached !== undefined) return cached;
    const existing = apiPending.get(key);
    if (existing && !existing.controller.signal.aborted) {if(existing.prefetch&&!parsed.searchParams.has('prefetch'))existing.controller.abort();else return waitForApiRequest(existing, signal);}
    const controller = new AbortController();
    const entry = { controller, users: 0, prefetch:parsed.searchParams.has('prefetch') };
    let timer;
    const request = (async () => {
        let body;
        const invoke = typeof tauriConstants !== 'undefined' ? tauriConstants.invoke : window.__TAURI_INTERNALS__?.invoke;
        const bridge = window.ROSETV_BRIDGE;
        const pooled = bridge?.enabled && method === 'GET';
        const requestUrl = pooled && !apiUrl.startsWith(bridge.url + '/')
            ? bridge.url + '/http?url=' + encodeURIComponent(apiUrl) : apiUrl;
        const requestHeaders = pooled ? { ...headers, 'X-RoseTV-Key': bridge.key } : headers;
        const failure=status=>{let data;try{data=JSON.parse(body);}catch{}const error=new Error(typeof data?.error==='string'?data.error:'资源接口返回 '+status);if(apiUrl.startsWith(bridge?.url+'/')&&data?.code==='local_budget'){error.code=data.code;error.retryAfterSeconds=Math.min(60,Math.max(1,Number(data.retryAfterSeconds)||1));}return error;};
        if (pooled) for (const name of Object.keys(requestHeaders)) if (name.toLowerCase() === 'user-agent') delete requestHeaders[name];
        // Fetch can cancel the local connection; the native command cannot cancel an in-flight request.
        if (invoke && !(pooled && typeof fetch === 'function')) {
            const response = await invoke('make_http_request', {
                options: { url: requestUrl, method, headers: requestHeaders, timeout_secs: timeoutSecs }
            });
            body = response.body;
            if (response.status < 200 || response.status >= 300) throw failure(response.status);
        } else {
            const response = await fetch(requestUrl, { method, headers: requestHeaders, signal: controller.signal,priority:parsed.searchParams.has('prefetch')?'low':'high' });
            body = await response.text();
            if (!response.ok) throw failure(response.status);
        }
        // Working sources also return JSON with a text/html Content-Type.
        return asText ? body : (window.roseParseAPIJSON||JSON.parse)(body);
    })();
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error('资源响应超时，可重试或切换其他源'));
        }, timeoutSecs * 1000);
    });
    const pending = Promise.race([request, deadline]).then(data => {
        if (method === 'GET' && !controller.signal.aborted) {
            const size = JSON.stringify(data).length * 2;
            apiCacheBytes -= apiCache.get(key)?.size || 0;
            apiCache.delete(key);
            if (size <= 1024 * 1024) {
                apiCache.set(key, { time: Date.now(), data, size }); apiCacheBytes += size;
            }
            while (apiCache.size > 80 || apiCacheBytes > 4 * 1024 * 1024) {
                const oldest = apiCache.keys().next().value;
                apiCacheBytes -= apiCache.get(oldest).size; apiCache.delete(oldest);
            }
        }
        return data;
    }).finally(() => { clearTimeout(timer); if (apiPending.get(key) === entry) apiPending.delete(key); });
    entry.promise = pending;
    apiPending.set(key, entry);
    return waitForApiRequest(entry, signal);
}

})();
window.roseOpenSources = async () => {
    let panel = document.getElementById('playerSourcePanel');
    if (panel && !panel.hidden) { panel.hidden = true; window.roseSourcePickerController?.abort(); return; }
    panel?.remove();
    window.roseSourcePickerController?.abort();const controller=window.roseSourcePickerController=new AbortController();
    panel = document.createElement('section'); panel.id = 'playerSourcePanel';
    panel.style.cssText = 'padding:16px;margin:8px 0 16px;background:#101d30;border:1px solid #30445d;border-radius:12px;color:#b9c9df';
    document.getElementById('playerContainer').before(panel);
    const heading = document.createElement('div'); heading.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px';
    const title = document.createElement('strong'); title.textContent = '切换来源 · ' + currentVideoTitle;
    const close = document.createElement('button'); close.append(window.roseIcon('close')); close.title = '收起来源'; close.setAttribute('aria-label', '收起来源'); close.onclick = () => { panel.hidden = true; controller.abort(); };
    heading.append(title, close); panel.append(heading);
    try {
        await window.bridgeReady;
        if (typeof executeApiRequest !== 'function') await new Promise((resolve, reject) => {
            const script = document.createElement('script'); script.src = 'js/apiRequestCore.js'; script.onload = resolve; script.onerror = reject; document.head.append(script);
        });
        const ids = JSON.parse(localStorage.getItem('selectedAPIs') || '[]');
        if (!ids.length) throw new Error('请先在设置中启用资源源');
        let cursor=0;
        await Promise.all(Array.from({length:Math.min(2,ids.length)},async()=>{while(cursor<ids.length&&!controller.signal.aborted){const id=ids[cursor++];
            const source = sourceInfo(id); if (!source) continue;
            const group = document.createElement('div'); group.style.cssText = 'margin-top:12px;padding-top:12px;border-top:1px solid #26364b';
            const status = document.createElement('p'); status.style.cssText = 'font-size:13px;color:#8faacb;margin-bottom:7px'; status.textContent = source.name + ' · 查询中…'; group.append(status); panel.append(group);
            try {
                const year = JSON.parse(sessionStorage.getItem('playbackLines') || '{}').year;
                let rows;
                if(typeof roseFindVideo==='function'){const match=await roseFindVideo(id,currentVideoTitle,year,JSON.parse(sessionStorage.getItem('roseCurrentItem')||'{}'),null,controller.signal);rows=match?[match]:[];}
                else{const data=await executeApiRequest(source.url+API_CONFIG.search.pagePath.replace('{query}',encodeURIComponent(currentVideoTitle)).replace('{page}','1'),{headers:API_CONFIG.search.headers});const normalize=text=>String(text).replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase();rows=(data.list||[]).filter(item=>normalize(item.vod_name)===normalize(currentVideoTitle)&&(!year||!item.vod_year||String(item.vod_year)===String(year))).slice(0,6);}
                if(controller.signal.aborted)return;
                status.textContent = source.name + (id === new URLSearchParams(location.search).get('source_code') ? ' · 当前来源' : '') + (rows.length ? '' : ' · 暂无匹配影片');
                for (const item of rows) {
                    const button = document.createElement('button');
                    button.style.cssText = 'display:inline-flex;align-items:center;gap:8px;padding:8px 12px;margin:3px 7px 3px 0;border:1px solid #38516d;border-radius:8px;background:#172b43;color:#c4e4fa;font-size:13px';
                    button.textContent = [item.vod_name, item.vod_year, item.vod_remarks].filter(Boolean).join(' · ');
                    button.onclick = async () => {
                        button.disabled = true; status.textContent = source.name + ' · 正在读取线路…';
                        try {
                            let video = item;
                            if (!video.vod_play_url) {
                                const details = await executeApiRequest((source.detail || source.url) + API_CONFIG.detail.path + encodeURIComponent(item.vod_id), { headers: API_CONFIG.detail.headers,signal:controller.signal });
                                video = details.list?.find(row => String(row.vod_id) === String(item.vod_id));
                            }
                            const resolved = typeof roseVideoGroups==='function'?await roseVideoGroups({...video,source_code:id},true,controller.signal):{item:video,groups:parsePlaybackGroups(video || {})};
                            if(controller.signal.aborted)return;
                            const groups = resolved.groups;
                            if (!groups.length) throw new Error('这个来源暂无播放地址，请选其他来源');
                            window.selectRosePlayback(id, source.name, groups, 0, resolved.item);
                            panel.hidden = true;
                            controller.abort();
                        } catch (error) { status.textContent = source.name + ' · ' + error.message; }
                        finally { button.disabled = false; }
                    };
                    group.append(button);
                }
            } catch (error) {
                if(controller.signal.aborted)return;
                status.textContent = source.name + ' · ' + error.message;
                const retry = document.createElement('button'); retry.textContent = '重试'; retry.onclick = () => { panel.remove(); window.openRoseSources(); }; group.append(retry);
            }
        }}));
    } catch (error) { const message = document.createElement('p'); message.textContent = error.message || '来源列表加载失败'; panel.append(message); }
};
/* RoseTV navigation and playback preferences. Served only by the local adapter. */
window.roseParseAPIJSON=body=>{try{return JSON.parse(body);}catch{
    if(/不支持搜索|搜索.*关闭|禁止搜索/.test(body))throw new Error('接口已关闭搜索，不能按片名匹配');
    if(/domain is for sale|domain.*parking/i.test(body))throw new Error('原域名已停用或转为出售页面，需要官方新接口');
    if(/captcha|Just a moment|challenge-platform/i.test(body))throw new Error('接口要求网站验证，不能直接获取 JSON');
    throw new Error('接口返回网页或非 JSON 数据，可能是地址失效或接口变更');
}};
window.roseEmbedded=typeof parent!=='undefined'&&parent!==window&&new URLSearchParams(location.search).get('embedded')==='1';
if(window.roseEmbedded){document.documentElement.classList.add('rose-embedded');window.__TAURI_INTERNALS__=parent.__TAURI_INTERNALS__;if(parent.ROSETV_BRIDGE.site)API_SITES.site={name:'教父资源',api:parent.ROSETV_BRIDGE.url};}
roseIconPaths.settings='M4 7h16M4 17h16M8 4v6M16 14v6';
roseIconPaths.sun='M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5';
roseIconPaths.folder='M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z';
// Lucide picture-in-picture-2 (ISC); original SVG and license are included locally.
roseIconPaths.pip='M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4';
const roseThemeMedia=window.matchMedia?.('(prefers-color-scheme: dark)');
window.roseApplyTheme=()=>{
    if(!document.documentElement)return;
    const mode=localStorage.getItem('roseTheme')||'light';document.documentElement.dataset.roseTheme=mode==='system'?(roseThemeMedia?.matches?'dark':'light'):mode==='dark'?'dark':'light';
    const accent=localStorage.getItem('roseAccent')||'#3975e5';document.documentElement.style.setProperty('--rose-accent',/^#[0-9a-f]{6}$/i.test(accent)?accent:'#3975e5');
};
window.roseSetTheme=(mode,accent)=>{if(['light','dark','system'].includes(mode))localStorage.setItem('roseTheme',mode);if(/^#[0-9a-f]{6}$/i.test(accent||''))localStorage.setItem('roseAccent',accent);roseApplyTheme();document.getElementById('rosePlayerFrame')?.contentWindow?.roseApplyTheme?.();};
roseApplyTheme();roseThemeMedia?.addEventListener('change',()=>roseApplyTheme());
window.addEventListener?.('storage',event=>{if(event.key==='roseTheme'||event.key==='roseAccent')roseApplyTheme();});
function roseAppearancePanel(){
    const card=document.createElement('div');card.className='rose-preference-card rose-appearance';const head=document.createElement('div');head.className='rose-appearance-head';const title=document.createElement('h2');title.textContent='外观';head.append(title,roseButton('恢复默认',()=>{roseSetTheme('light','#3975e5');card.replaceWith(roseAppearancePanel());}));const note=document.createElement('p');note.className='rose-setting-note';note.textContent='选择喜欢的模式与强调色，首页和播放页会同步切换。';card.append(head,note);
    const modes=document.createElement('div');modes.className='rose-theme-modes';modes.setAttribute('aria-label','主题模式');
    for(const[mode,label]of [['system','跟随系统'],['light','浅色'],['dark','深色']]){const button=roseButton('',()=>{roseSetTheme(mode);for(const item of modes.children){const selected=item===button;item.classList.toggle('selected',selected);item.setAttribute('aria-pressed',String(selected));}},'rose-theme-choice');const preview=document.createElement('span');preview.className='rose-theme-preview '+mode;const caption=document.createElement('span');caption.textContent=label;button.append(preview,caption);button.classList.toggle('selected',mode===(localStorage.getItem('roseTheme')||'light'));button.setAttribute('aria-pressed',String(mode===(localStorage.getItem('roseTheme')||'light')));modes.append(button);}card.append(modes);
    const row=document.createElement('div');row.className='rose-appearance-row';const text=document.createElement('span');text.textContent='强调色';const colors=document.createElement('div');colors.className='rose-accent-colors';const select=document.createElement('select');select.setAttribute('aria-label','强调色');
    for(const[color,label]of [['#3975e5','默认蓝'],['#278866','森林绿'],['#8458c7','鸢尾紫'],['#c65879','玫瑰粉'],['custom','自定义']]){const option=document.createElement('option');option.value=color;option.textContent=label;select.append(option);}
    const custom=document.createElement('label');custom.className='rose-custom-accent';const dot=document.createElement('span'),caption=document.createElement('span');caption.textContent='选择颜色';const picker=document.createElement('input');picker.type='color';picker.value=localStorage.getItem('roseAccent')||'#3975e5';picker.setAttribute('aria-label','选择自定义强调色');custom.append(dot,caption,picker);const sync=()=>{select.value=['#3975e5','#278866','#8458c7','#c65879'].includes(picker.value)?picker.value:'custom';dot.style.backgroundColor=picker.value;custom.hidden=select.value!=='custom';};select.onchange=()=>{if(select.value==='custom'){custom.hidden=false;picker.click();}else{picker.value=select.value;roseSetTheme(null,picker.value);sync();}};picker.oninput=()=>{roseSetTheme(null,picker.value);sync();};sync();colors.append(select,custom);row.append(text,colors);card.append(row);return card;
}
API_SITES.rose_hn = { name: '红牛资源', api: 'https://www.hongniuzy2.com' };
function rosePrepareSources(){
    const normalized=address=>{try{const u=new URL(address);return u.hostname.replace(/^www\./,'')+u.pathname.replace(/\/$/,'');}catch{return address;}};
    const previous=new Map(Object.entries(API_SITES).filter(([id])=>id.startsWith('rose_public_')).map(([id,source])=>[id,normalized(source.api||source.url)]));for(const id of previous.keys())delete API_SITES[id];
    const aliases={};for(const[ index,api]of JSON.parse(localStorage.getItem('customAPIs')||'[]').entries()){
        if(api.name==='教父资源'||/^http:\/\/127\.0\.0\.1:34771(?:\/|$)/.test(api.url)){aliases['custom_'+index]='site';continue;}
        const old='custom_'+index;let match=Object.keys(API_SITES).find(id=>id!=='site'&&normalized(API_SITES[id].api||API_SITES[id].url)===normalized(api.url));match ||= {'cj.rycjapi.com':'ruyi','tyyszy.com':'tyyszy','dbzy.com':'dbzy'}[normalized(api.url)];
        if(!match){match='rose_public_'+index;API_SITES[match]={name:api.name,api:api.url,detail:api.detail,adult:!!api.isAdult};}aliases[old]=match;
    }
    const selected=[...new Set(JSON.parse(localStorage.getItem('selectedAPIs')||(typeof selectedAPIs!=='undefined'?JSON.stringify(selectedAPIs):'[]')).map(id=>previous.has(id)?Object.keys(API_SITES).find(key=>normalized(API_SITES[key].api||API_SITES[key].url)===previous.get(id)):aliases[id]||id).filter(id=>id==='site'||API_SITES[id]))];localStorage.setItem('selectedAPIs',JSON.stringify(selected));if(typeof selectedAPIs!=='undefined')selectedAPIs=selected;
}
rosePrepareSources();
if (typeof selectedAPIs !== 'undefined' && !localStorage.getItem('roseSourcesAdded')) { selectedAPIs = [...new Set([...selectedAPIs.filter(id=>id!=='testSource'), 'rose_hn'])]; localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs)); localStorage.setItem('roseSourcesAdded','1'); }
if(API_SITES.rose_lz&&API_SITES.rose_sb&&typeof selectedAPIs!=='undefined'&&!localStorage.getItem('roseSourceUpdate20261025')){selectedAPIs=[...new Set([...selectedAPIs,'rose_lz','rose_sb'])];localStorage.setItem('selectedAPIs',JSON.stringify(selectedAPIs));localStorage.setItem('roseSourceUpdate20261025','1');}
const roseKinds = { mv: '电影', tv: '剧集', ac: '动漫', variety: '综艺', doc: '纪录片' };
const roseFormalGenres=new Set('剧情 喜剧 动作 爱情 科幻 动画 悬疑 惊悚 恐怖 纪录 纪录片 短片 情色 同性 音乐 歌舞 家庭 儿童 传记 历史 战争 犯罪 西部 奇幻 冒险 灾难 武侠 古装 运动 黑色电影 戏曲 真人秀 脱口秀 舞台艺术'.split(' '));
function roseTopicFilter(filters){return(filters.genre||'').split(',').some(value=>value&&!roseFormalGenres.has(value));}
let roseLibraryGeneration = 0, roseOpenGeneration = 0;
let rosePosterGeneration=0,rosePosterActive=0,rosePosterQueue=[];
let roseImageController=new AbortController(),roseImageQueue=[],roseImageActive=0,roseImageURLs=new Set();
function roseResetPosters(){rosePosterGeneration++;rosePosterQueue=[];window.rosePosterObserver?.disconnect();roseImageController.abort();roseImageController=new AbortController();roseImageQueue=[];window.roseImageObserver?.disconnect();window.roseImageObserver=null;for(const address of roseImageURLs)URL.revokeObjectURL(address);roseImageURLs.clear();}
window.addEventListener?.('pagehide',roseResetPosters);
window.roseLoadPoster=(image,address)=>{
    if(typeof fetch!=='function'||typeof URL.createObjectURL!=='function'){image.src=address;return;}
    image.roseImageAddress=address;image.dataset.roseImageState='queued';
    const signal=roseImageController.signal,job={image,address,signal};image.roseImageJob=job;
    if(typeof IntersectionObserver==='undefined'){roseImageQueue.push(job);rosePumpImages();return;}
    if(!window.roseImageObserver)window.roseImageObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){const target=entry.target,job=target.roseImageJob;delete target.roseImageJob;window.roseImageObserver.unobserve(target);if(job&&!job.signal.aborted)roseImageQueue.push(job);}rosePumpImages();},{rootMargin:'200px'});
    window.roseImageObserver.observe(image);
};
function rosePumpImages(){
    while(roseImageActive<4&&roseImageQueue.length){
        const {image,address,signal}=roseImageQueue.shift();if(signal.aborted)continue;roseImageActive++;
        (async()=>{const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,5000);
            try{
                image.dataset.roseImageState='loading';const response=await fetch(address,{cache:'force-cache',priority:'high',signal:controller.signal});if(!response.ok)throw new Error('海报响应失败');
                const blob=await response.blob();if(controller.signal.aborted)return;
                const objectURL=URL.createObjectURL(blob);roseImageURLs.add(objectURL);image.dataset.roseImageState='ready';image.loading='eager';image.src=objectURL;
            }catch(error){if(!signal.aborted){image.dataset.roseImageState='error';image.roseRetryAddress=address;image.roseRetryButton&&(image.roseRetryButton.disabled=false);image.onerror?.();}}
            finally{clearTimeout(timer);signal.removeEventListener('abort',abort);roseImageActive--;rosePumpImages();}
        })();
    }
}
window.roseRecoverPoster=(item,image)=>{
    if(image.dataset.roseRecovery)return;image.dataset.roseRecovery='queued';
    const card=image.closest('.rose-poster');if(!card?.isConnected)return;
    const retry=roseButton(image.roseRetryAddress?'重试海报':'补充海报',event=>{event.preventDefault();event.stopPropagation();retry.disabled=true;if(image.roseRetryAddress){roseLoadPoster(image,image.roseRetryAddress);return;}roseQueuePoster(card);},'rose-cover-retry');image.roseRetryButton=retry;
    image.addEventListener('load',()=>retry.remove(),{once:true});
    card.rosePosterJob={item,image,card,retry,generation:rosePosterGeneration};card.parentElement.append(retry);
};
function roseQueuePoster(card){if(card.rosePosterJob){rosePosterQueue.push(card.rosePosterJob);delete card.rosePosterJob;rosePumpPosters();}}
function rosePumpPosters(){
    while(rosePosterActive<2&&rosePosterQueue.length){
        const job=rosePosterQueue.shift();if(!job.card.isConnected||job.generation!==rosePosterGeneration)continue;
        rosePosterActive++;
        (async()=>{
            await roseEnsureAPI();
            if(!job.card.isConnected||job.generation!==rosePosterGeneration)return;
            const ids=JSON.parse(localStorage.getItem('selectedAPIs')||'[]');
            const id=ids.find(id=>id!=='site'&&/360zy\.com/.test(sourceInfo(id)?.url||''))||ids.find(id=>id!=='site'&&roseReliableSource(id));if(!id)return;
            const found=await roseFindVideo(id,job.item.vod_name,job.item.vod_year,job.item,null,window.roseBrowseController?.signal),address=found?.vod_pic;
            if(!job.card.isConnected||job.generation!==rosePosterGeneration||!/^https?:\/\//i.test(address||'')||/(?:movie|tv)_default|default_(?:large|small)|nopic/i.test(address))return;
            job.image.srcset='';window.roseLoadPoster(job.image,window.ROSETV_BRIDGE?.key?window.ROSETV_BRIDGE.mediaURL(address):address);
        })().catch(()=>{}).finally(()=>{if(job.card.isConnected&&job.generation===rosePosterGeneration){job.card.rosePosterJob=job;if(job.retry)job.retry.disabled=false;}else job.retry?.remove();rosePosterActive--;rosePumpPosters();});
    }
}
let roseFilters = JSON.parse(sessionStorage.getItem('roseFilters') || '{}');
if(!sessionStorage.getItem('roseLanguageTagsUpdated')){for(const filters of Object.values(roseFilters))if(filters.lang&&filters.sort==='R'&&!roseAdvanced(filters))filters.sort='U';sessionStorage.setItem('roseLanguageTagsUpdated','1');sessionStorage.setItem('roseFilters',JSON.stringify(roseFilters));}
const rosePlayerTabs=[];
let roseActivePlayerTab=null,rosePlayerTabSequence=0;
function roseExistingPlayerTab(item){return rosePlayerTabs.find(tab=>Number(item.vod_douban_id)>0&&Number(tab.item?.vod_douban_id)===Number(item.vod_douban_id)||tab.title===item.vod_name&&(!item.vod_year||!tab.item?.vod_year||String(item.vod_year)===String(tab.item.vod_year)));}
if(!sessionStorage.getItem('roseScoreSortFixed')){for(const filters of Object.values(roseFilters))if(filters.sort==='T')filters.sort='S';sessionStorage.setItem('roseScoreSortFixed','1');sessionStorage.setItem('roseFilters',JSON.stringify(roseFilters));}
document.getElementById('disclaimerModal')?.remove();
window.roseGoHome = () => {
    if(window.roseEmbedded){parent.roseGoHome();return;}
    if (typeof saveCurrentProgress === 'function') saveCurrentProgress();
    sessionStorage.setItem('activeTab', 'home');
    sessionStorage.setItem('roseCatalogState', JSON.stringify({ kind: 'home', page: 1 }));
    if (location.pathname.includes('player.html')) location.href = 'index.html';
    else navigateToTab('home','home');
};
function roseButton(label, action, className = 'rose-chip') {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'rose-button '+className; button.textContent = label; button.onclick = action; return button;
}
if(typeof rosePoster==='function'){
    const poster=window.rosePoster;window.rosePoster=(item,open)=>{
        roseUseMetadata(item);const play=poster(item),card=document.createElement('div');card.className='rose-poster-card';card.append(play);
        play.querySelector('.rose-card-genres')?.remove();const meta=play.querySelector('p'),note=document.createElement('p');note.className='rose-card-genres';play.append(note);
        const favorite=roseButton('',event=>{event.preventDefault();event.stopPropagation();roseToggleFavorite(item);},'rose-card-favorite');favorite.roseMovieItem=item;favorite.append(window.roseIcon('star',17));card.append(favorite);
        const refresh=()=>{if(meta)meta.textContent=[item.vod_year,item.vod_area].filter(Boolean).join(' / ');note.textContent=roseMovieGenres(item).join(' / ')||'类型暂未提供';roseRefreshFavorite(favorite);};card.roseMovieItem=play.roseMovieItem=item;card.roseRefreshMetadata=play.roseRefreshMetadata=refresh;refresh();
        if(open)play.onclick=async()=>{play.disabled=true;play.setAttribute('aria-busy','true');try{await open();}finally{play.disabled=false;play.removeAttribute('aria-busy');}};return card;
    };
}
function roseMetadataID(item){const id=item.vod_douban_id||(item.source_code==='metadata'?item.vod_id:'');return /^\d{1,10}$/.test(String(id))&&Number(id)>0?String(id):'';}
function roseMetadataKey(item){const id=roseMetadataID(item),title=roseTitleIdentity(item.vod_name,item.vod_year);return id?'douban:'+id:title.title+'|'+title.year;}
let roseMetadataCache,roseMetadataTimer,roseMetadataDirty=false;
function roseMetadataRows(){if(!roseMetadataCache){roseMetadataCache=JSON.parse(localStorage.getItem('roseMovieMetadata')||'{}');for(const row of Object.values(roseMetadataCache))if(row.fields?.vod_douban_id)roseMetadataCache['douban:'+row.fields.vod_douban_id] ||= row;}return roseMetadataCache;}
function roseFlushMetadata(){clearTimeout(roseMetadataTimer);roseMetadataTimer=null;if(!roseMetadataCache||!roseMetadataDirty)return;const rows=[];let bytes=4;for(const row of Object.entries(roseMetadataCache).reverse()){if(Date.now()-row[1].time>=30*86400000)continue;const size=JSON.stringify(row).length*2;if(rows.length>=600||bytes+size>512*1024)break;rows.push(row);bytes+=size;}roseMetadataCache=Object.fromEntries(rows.reverse());try{localStorage.setItem('roseMovieMetadata',JSON.stringify(roseMetadataCache));roseMetadataDirty=false;}catch{}}
window.addEventListener?.('pagehide',roseFlushMetadata);
window.addEventListener?.('storage',event=>{if(event.key==='roseMovieMetadata')roseMetadataCache=undefined;});
function roseUseMetadata(item){const rows=roseMetadataRows(),saved=rows[roseMetadataKey(item)];if(saved&&Date.now()-saved.time<30*86400000)for(const [field,value]of Object.entries(saved.fields))if(!item[field]||field==='vod_class'&&roseMovieGenres({vod_class:value}).length>roseMovieGenres(item).length)item[field]=value;}
window.roseRememberMetadata=item=>{
    roseUseMetadata(item);
    const fields={};for(const field of ['vod_name','vod_year','vod_area','vod_class','vod_lang','vod_douban_id'])if(item[field])fields[field]=String(item[field]).slice(0,300);if(roseMetadataID(item))fields.vod_douban_id=roseMetadataID(item);
    if(!fields.vod_class&&!fields.vod_area)return;
    const saved=roseMetadataRows(),key=roseMetadataKey(item),changed=JSON.stringify(saved[key]?.fields)!==JSON.stringify(fields);if(!changed)return;delete saved[key];saved[key]={time:Date.now(),fields};roseMetadataDirty=true;if(!roseMetadataTimer)roseMetadataTimer=setTimeout(roseFlushMetadata,0);
    for(const card of document.querySelectorAll('.rose-poster'))if(card.roseMovieItem&&roseMetadataKey(card.roseMovieItem)===key){roseUseMetadata(card.roseMovieItem);card.roseRefreshMetadata?.();}
    if(window.roseEmbedded)parent.roseRememberMetadata(item);
};
if(typeof playFromHistory==='function')window.playFromHistory=(address,title,index=0,position=0)=>{
    const existing=roseExistingPlayerTab({vod_name:title});if(existing){roseShowPlayer(existing.id);return;}if(rosePlayerTabs.length>=12){showToast('最多保留 12 个影片标签，请先关闭一个');return;}roseSavePlayerTab();
    const item=JSON.parse(localStorage.getItem('viewingHistory')||'[]').find(row=>row.title===title);
    if(item?.episodes?.length)localStorage.setItem('currentEpisodes',JSON.stringify(item.episodes));
    let url=new URL(address,location.href);if(!url.pathname.endsWith('/player.html')){const direct=url.href;url=new URL('player.html',location.href);url.searchParams.set('url',direct);}
    url.searchParams.set('title',title);url.searchParams.set('index',String(index));if(position>10)url.searchParams.set('position',String(position));
    if(!url.searchParams.get('source_code')){const id=JSON.parse(localStorage.getItem('selectedAPIs')||'[]').find(id=>roseSourceName(id)===item?.sourceName);if(id)url.searchParams.set('source_code',id);}
    if(!url.searchParams.get('source')&&item?.sourceName)url.searchParams.set('source',item.sourceName);
    sessionStorage.setItem('roseCurrentItem',JSON.stringify({vod_name:title,source_code:url.searchParams.get('source_code')||''}));sessionStorage.setItem('roseSelection',JSON.stringify({mode:'manual',reason:'继续上次观看的来源和位置'}));showVideoPlayer(url.href);
};
function roseNavigate(page, kind) {
    if(window.roseEmbedded){parent.roseNavigate(page,kind);return;}
    if (typeof saveCurrentProgress === 'function') saveCurrentProgress();
    if (location.pathname.includes('player.html')) {
        sessionStorage.setItem('activeTab',page);
        if(kind)sessionStorage.setItem('roseCatalogState',JSON.stringify({kind,page:1}));
        location.href='index.html';return;
    }
    navigateToTab(page,kind);
}
function roseSubmitSearch(query){
    query=query.trim();if(!query)return;
    if(location.pathname.includes('player.html')){sessionStorage.setItem('roseSearchQuery',query);roseNavigate('search');}
    else{document.getElementById('searchInput').value=query;navigateToTab('search');search();}
}
let roseSuggestSequence=0;
function roseBindSuggestions(input,form){
    const list=document.createElement('div');list.className='rose-search-suggestions';list.id='roseSuggestions'+(++roseSuggestSequence);list.hidden=true;list.setAttribute('role','listbox');list.setAttribute('aria-label','可能的影片');form.append(list);
    input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls',list.id);input.setAttribute('aria-expanded','false');input.autocomplete='off';
    let timer,version=0,active=-1,composing=false,rows=[],controller;
    const close=()=>{clearTimeout(timer);controller?.abort();version++;list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;};
    const choose=title=>{close();input.value=title;roseSubmitSearch(title);};
    const update=()=>{clearTimeout(timer);controller?.abort();const generation=++version,query=input.value.trim();active=-1;rows=[];list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');if(!query||composing){close();return;}timer=setTimeout(async()=>{
        try{if(input.isConnected===false)return;window.roseSuggestController?.abort();controller=window.roseSuggestController=new AbortController();await roseEnsureAPI();const bridge=await bridgeReady;const data=await executeApiRequest(bridge.url+'/suggest?q='+encodeURIComponent(query),{timeoutSecs:8,signal:controller.signal});if(version!==generation||input.isConnected===false||input.value.trim()!==query)return;rows=data.list||[];list.replaceChildren();for(const [i,row]of rows.entries()){const button=roseButton('',()=>choose(row.title),'rose-suggestion');button.id=list.id+'-'+i;button.setAttribute('role','option');button.setAttribute('aria-selected','false');const title=document.createElement('span'),year=document.createElement('small');title.textContent=row.title;year.textContent=row.year;button.append(title,year);button.onpointerdown=event=>event.preventDefault();list.append(button);}list.hidden=!rows.length;input.setAttribute('aria-expanded',String(rows.length>0));}
        catch{if(version===generation){list.replaceChildren();const note=document.createElement('p');note.textContent='联想暂时不可用，按 Enter 直接搜索';list.append(note);list.hidden=false;input.setAttribute('aria-expanded','true');}}
    },800);};
    input.oninput=event=>{if(event?.isComposing){composing=true;close();return;}update();};input.addEventListener('compositionstart',()=>{composing=true;close();});input.addEventListener('compositionend',()=>{composing=false;update();});input.onfocus=()=>{if(input.value.trim())update();};input.onblur=()=>setTimeout(close,120);
    input.onkeydown=event=>{if(event.isComposing||composing)return;if(event.key==='Escape'){close();return;}if(!list.hidden&&rows.length&&['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();active=event.key==='ArrowDown'?(active+1)%rows.length:(active+rows.length-1)%rows.length;[...list.children].forEach((node,i)=>node.setAttribute('aria-selected',String(i===active)));input.setAttribute('aria-activedescendant',list.children[active].id);list.children[active].scrollIntoView?.({block:'nearest'});}else if(event.key==='Enter'&&!list.hidden&&active>=0){event.preventDefault();choose(rows[active].title);}};
    form.onsubmit=event=>{event.preventDefault();close();roseSubmitSearch(input.value);};
}
window.renderRoseBrowseNav = () => {
    window.roseSuggestController?.abort();
    const bar=document.getElementById('rosetvWindowBar');if(!bar)return;
    const drag=bar.querySelector('.rose-drag');
    let nav = document.getElementById('roseBrowseNav');
    if (!nav) { nav = document.createElement('nav'); nav.id = 'roseBrowseNav'; nav.className = 'rose-nav'; bar.insertBefore(nav,bar.querySelector('.rose-drag')); }
    if(nav.parentElement!==bar)bar.insertBefore(nav,bar.querySelector('.rose-drag'));
    nav.replaceChildren();const activePage=sessionStorage.getItem('activeTab')||'home',watching=!!document.getElementById('rosePlayerFrame')&&!document.getElementById('rosePlayerFrame').hidden,browsing=activePage==='home'&&!watching;
    for (const [kind, label] of Object.entries(roseKinds)) {
        const button = roseButton(label, () => roseNavigate('home',kind), 'rose-nav-item');const selected=browsing&&typeof homeView!=='undefined'&&homeView.kind===kind;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));nav.append(button);
    }
    const compact=document.createElement('select');compact.className='rose-compact-category';compact.setAttribute('aria-label','浏览分类');
    for(const [kind,label]of Object.entries({home:'首页',...roseKinds})){const option=document.createElement('option');option.value=kind;option.textContent=label;option.selected=typeof homeView!=='undefined'&&homeView.kind===kind;compact.append(option);}compact.onchange=()=>roseNavigate('home',compact.value);nav.append(compact);
    const tabs=document.createElement('div');tabs.className='rose-player-tabs';tabs.setAttribute('aria-label','已打开的影片');
    for(const tab of rosePlayerTabs){const group=document.createElement('div');group.className='rose-player-tab';const active=tab.id===roseActivePlayerTab&&!document.getElementById('rosePlayerFrame')?.hidden;group.classList.toggle('active',active);const button=roseButton('',()=>roseShowPlayer(tab.id),'rose-playing-tab');button.title='返回播放：'+tab.title;button.setAttribute('aria-pressed',String(active));button.append(window.roseIcon('play',14),document.createTextNode(tab.title));const close=roseButton('',()=>roseClosePlayer(tab.id),'rose-tab-close');close.title='关闭 '+tab.title+'，保留进度';close.setAttribute('aria-label',close.title);close.append(window.roseIcon('close',14));group.append(button,close);tabs.append(group);}nav.append(tabs);if(drag)nav.append(drag);
    const form = document.createElement('form'), input = document.createElement('input');
    input.placeholder = '搜索影片、剧集'; input.setAttribute('aria-label', '搜索影片、剧集');
    const submit = roseButton('', () => {}, 'rose-search-submit'); submit.type = 'submit'; submit.title = '搜索'; submit.setAttribute('aria-label', '搜索'); submit.append(window.roseIcon('search', 18));
    form.append(input, submit);roseBindSuggestions(input,form);
    nav.append(form);
    for (const [page, label, icon] of [['favorites','我的收藏','star'],['history','观看历史','history'],['settings','设置','settings']]) {
        const button = roseButton('', () => page==='favorites'?roseNavigate('home','favorites'):roseNavigate(page), 'rose-nav-tool');const selected=page==='favorites'?browsing&&homeView.kind==='favorites':activePage===page&&!watching;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));button.title = label; button.setAttribute('aria-label', label); button.append(window.roseIcon(icon, 19)); nav.append(button);
    }
};
function roseSavePlayerTab(){
    const tab=rosePlayerTabs.find(tab=>tab.id===roseActivePlayerTab),frame=document.getElementById('rosePlayerFrame');if(!tab||!frame)return;
    try{const state=frame.contentWindow.rosePlaybackSnapshot?.();if(state&&state.title===tab.title){tab.state=state;tab.url=state.url;tab.item=state.item;tab.resume=state.playing||!!window.roseResumePlayback;}}catch{}
}
function roseHidePlayer(){
    const frame=document.getElementById('rosePlayerFrame');if(!frame||frame.hidden)return;
    roseSavePlayerTab();
    try{window.roseResumePlayback=frame.contentWindow.rosePauseForBrowse?.()||false;}catch{}
    frame.hidden=true;document.body.classList.remove('rose-watching');
    renderRoseBrowseNav();
}
function roseStopBrowse(){window.roseBrowseController?.abort();window.roseHomeObserver?.disconnect();clearTimeout(window.rosePrefetchTimer);window.isLoadingHomePageItems=false;roseLibraryGeneration++;if(typeof homeGeneration!=='undefined')homeGeneration++;roseResetPosters();}
function roseShowPlayer(id=roseActivePlayerTab){
    const tab=rosePlayerTabs.find(tab=>tab.id===id);if(!tab)return;
    roseStopBrowse();
    window.cancelSearchLoad?.();
    window.roseSourceTestController?.abort();
    roseOpenGeneration++;
    if(id!==roseActivePlayerTab){roseHidePlayer();roseRestorePlayerTab(tab);}
    const frame=document.getElementById('rosePlayerFrame');if(!frame)return;
    document.querySelectorAll('.page-content').forEach(page=>page.classList.add('hidden'));frame.hidden=false;document.body.classList.add('rose-watching');
    if(frame.dataset.roseLoading!=='1')try{frame.contentWindow.roseResumeFromBrowse?.(!!window.roseResumePlayback);}catch{}window.roseResumePlayback=false;
    window.scrollTo(0,0);
    renderRoseBrowseNav();
}
function roseRestorePlayerTab(tab){
    if(tab.state){for(const[key,value]of Object.entries(tab.state.session))value===null?sessionStorage.removeItem(key):sessionStorage.setItem(key,value);localStorage.setItem('currentEpisodes',JSON.stringify(tab.state.episodes));localStorage.setItem('episodesReversed',String(tab.state.reversed));}
    roseActivePlayerTab=tab.id;window.rosePlaying=tab.title;window.rosePlayerReturnPage=tab.returnPage;
    let frame=document.getElementById('rosePlayerFrame');if(!frame){frame=document.createElement('iframe');frame.id='rosePlayerFrame';frame.title='影片播放器';frame.allow='autoplay; fullscreen; picture-in-picture';frame.setAttribute('allowfullscreen','');document.body.append(frame);}
    frame.onload=()=>{frame.dataset.roseLoading='';if(frame.hidden)window.roseResumePlayback=frame.contentWindow.rosePauseForBrowse?.()||false;else frame.contentWindow.focus();};
    const url=new URL(tab.url,location.href);url.searchParams.set('embedded','1');if(tab.state){url.searchParams.set('rate',String(tab.state.rate));url.searchParams.set('resume',tab.resume?'1':'0');}window.roseResumePlayback=false;frame.dataset.roseLoading='1';frame.src=url.href;
}
function roseStartPlayer(address){
    const url=new URL(address,location.href),title=url.searchParams.get('title')||'影片';const item=JSON.parse(sessionStorage.getItem('roseCurrentItem')||'{}');
    const existing=roseExistingPlayerTab({...item,vod_name:title});if(existing){roseShowPlayer(existing.id);return;}
    if(rosePlayerTabs.length>=12){showToast('最多保留 12 个影片标签，请先关闭一个');return;}
    const tab={id:++rosePlayerTabSequence,title,item,url:url.href,returnPage:sessionStorage.getItem('activeTab')||'home'};rosePlayerTabs.push(tab);roseRestorePlayerTab(tab);roseShowPlayer();
}
function roseClosePlayer(id=roseActivePlayerTab){
    const index=rosePlayerTabs.findIndex(tab=>tab.id===id);if(index<0)return;
    const active=id===roseActivePlayerTab,frame=document.getElementById('rosePlayerFrame'),visible=active&&frame&&!frame.hidden;
    if(active){roseHidePlayer();frame?.remove();roseActivePlayerTab=null;window.rosePlaying='';window.roseResumePlayback=false;}
    rosePlayerTabs.splice(index,1);renderRoseBrowseNav();
    if(visible){const next=rosePlayerTabs[Math.min(index,rosePlayerTabs.length-1)];if(next)roseShowPlayer(next.id);else navigateToTab(window.rosePlayerReturnPage||'home');}
}
window.rosePlaybackSnapshot=()=>{if(typeof currentVideoTitle==='undefined'||typeof dp==='undefined'||!dp?.video)return null;saveCurrentProgress();const video=dp.video,url=new URL(location.href);url.searchParams.set('url',currentEpisodes[currentEpisodeIndex]||currentVideoUrl);url.searchParams.set('index',String(currentEpisodeIndex));url.searchParams.set('position',String(video.readyState?video.currentTime:Number(url.searchParams.get('position'))||0));return{title:currentVideoTitle,url:url.href,item:JSON.parse(sessionStorage.getItem('roseCurrentItem')||'{}'),session:Object.fromEntries(['roseCurrentItem','playbackLines','roseSelection'].map(key=>[key,sessionStorage.getItem(key)])),episodes:[...currentEpisodes],reversed:episodesReversed,rate:video.playbackRate,playing:!video.paused};};
if(typeof roseGoBack==='function'){
    const back=window.roseGoBack;window.roseGoBack=()=>{if(window.roseEmbedded){parent.roseGoBack();return;}const frame=document.getElementById('rosePlayerFrame');if(frame&&!frame.hidden){const panel=frame.contentDocument?.getElementById('playerSourcePanel');if(panel&&!panel.hidden){panel.hidden=true;return;}navigateToTab(window.rosePlayerReturnPage||'home');return;}back();};
}
if(window.roseEmbedded)window.addEventListener('keydown',event=>{if(event.altKey&&event.key==='ArrowLeft'){event.preventDefault();event.stopImmediatePropagation();parent.roseGoBack();}},true);
window.rosePauseForBrowse=()=>{window.roseQualityCheck?.abort();window.roseFallbackController?.abort();window.roseInfoController?.abort();window.roseSourcePickerController?.abort();if(typeof dp==='undefined'||!dp?.video)return false;saveCurrentProgress();if(document.pictureInPictureElement===dp.video)return false;window.roseBrowsing=true;const playing=!dp.video.paused;autoplayEnabled=false;dp.video.pause();currentHls?.stopLoad();return playing;};
window.roseResumeFromBrowse=play=>{const stopped=window.roseBrowsing;window.roseBrowsing=false;if(typeof dp!=='undefined'&&dp?.video){autoplayEnabled=localStorage.getItem('autoplayEnabled')!=='false';if(stopped){if(currentHls&&!currentHls.levels.length)currentHls.loadSource(dp.options.video.url);currentHls?.startLoad(dp.video.currentTime);}if(play)dp.video.play().catch(()=>{});}};
if(typeof clearViewingHistory==='function'){
    const clear=window.clearViewingHistory;window.clearViewingHistory=()=>{localStorage.setItem('roseHistoryClearedAt',Date.now());clear();};
}
if(typeof saveToHistory==='function'){
    window.roseHistoryStartedAt=Date.now();const save=window.saveToHistory;window.saveToHistory=()=>{if(Number(localStorage.getItem('roseHistoryClearedAt')||0)>window.roseHistoryStartedAt)return;save();};
}
if(typeof playEpisode==='function'){
    const play=window.playEpisode;window.playEpisode=(...args)=>{window.roseHistoryStartedAt=Date.now();return play(...args);};
}
window.roseMountHeader=()=>{renderRoseBrowseNav();document.title=document.title.replaceAll('RoseTV','RoseTV');for(const label of document.querySelectorAll('footer .gradient-text'))if(label.textContent==='RoseTV')label.textContent='RoseTV';const credit=document.querySelector('footer p');if(credit?.textContent.includes('RoseTV'))credit.textContent='RoseTV · 基于 RoseTV 开源项目';const old=document.querySelector('.player-header');if(old){const title=document.getElementById('videoTitle');old.replaceChildren(title);old.classList.add('rose-player-title');}window.rosePlayerExtras?.();};
function roseFilterRows(kind, panel) {
    const filters = roseFilters[kind] || {};
    const genres = ['剧情','科幻','动作','喜剧','爱情','冒险','儿童','歌舞','音乐','奇幻','魔幻','动画','恐怖','惊悚','丧尸','战争','传记','纪录','犯罪','悬疑','推理','警匪','谍战','西部','灾难','末日','古装','武侠','家庭','短片','校园','文艺','运动','青春','同性','情色','励志','人性','美食','女性','治愈','历史','黑色电影','公路','社会','超级英雄','戏曲','舞台艺术','真人秀','脱口秀'];
    if(kind==='ac')genres.push('热血','搞笑','机战','推理','日常');
    const year = new Date().getFullYear();
    for (const [key, title, values] of [['genre','类型',genres], ['year','年代',['近三年',...Array.from({length:year-1999},(_,i)=>String(year-i)),'2020年代','2010年代','2000年代','1990年代','1980年代','1970年代','1960年代','更早']], ['region','地区',['中国大陆','中国香港','中国台湾','美国','日本','韩国','英国','法国','德国','印度','泰国','瑞典','巴西','加拿大','俄罗斯','意大利','西班牙','澳大利亚','丹麦','挪威','芬兰','荷兰','比利时','瑞士','奥地利','波兰','捷克','匈牙利','土耳其','伊朗','以色列','墨西哥','阿根廷','新西兰','新加坡','马来西亚','印度尼西亚','菲律宾','越南','南非','埃及']], ['lang','语言',['汉语普通话','英语','日语','韩语','粤语','法语','德语','俄语','闽南语','丹麦语','波兰语','瑞典语','印地语','挪威语','意大利语','西班牙语','葡萄牙语','泰语','阿拉伯语','荷兰语','芬兰语','希伯来语','波斯语','土耳其语','捷克语','匈牙利语','越南语','印度尼西亚语','马来语','无对白']]]) {
        const row = document.createElement('div'); row.className = 'rose-filter-row';
        const label = document.createElement('span'); label.className = 'rose-filter-label'; label.textContent = title; row.append(label);
        const choices=document.createElement('div');choices.className='rose-filter-choices';row.append(choices);
        if(key!=='genre'&&sessionStorage.getItem('roseExpandFilters')!=='true')choices.classList.add('collapsed');
        for (const value of ['', ...values]) {
            const selected=key==='genre'?(filters.genre||'').split(','):[filters[key]||''];
            const button = roseButton(value || '全部', () => {let next=value;if(key==='genre'&&value&&filters.genreMode&&filters.genreMode!=='single'){const set=new Set(selected.filter(Boolean));if(set.has(value))set.delete(value);else set.add(value);next=[...set].join(',');}roseFilters[kind] = { ...filters, [key]: next };if(roseAdvanced(roseFilters[kind]))roseFilters[kind].sort='R';showRoseCatalog(kind, 1); });
            button.classList.toggle('selected',value?selected.includes(value):!selected.some(Boolean));if(key==='genre'&&value&&!roseFormalGenres.has(value)&&roseAdvanced(filters)){button.disabled=true;button.title='来源接口没有该题材字段；请先取消来源画质、状态或任意/排除组合';}if(selected.includes(value)&&values.indexOf(value)>=10)choices.classList.remove('collapsed');choices.append(button);
        }
        if(key==='genre'){const mode=document.createElement('select');mode.className='rose-genre-mode';mode.setAttribute('aria-label','类型组合方式');for(const[value,text]of [['single','单选'],['any','多选 · 任意匹配'],['all','多选 · 同时匹配'],['exclude','排除所选类型']]){const option=document.createElement('option');option.value=value;option.textContent=text;option.selected=value===(filters.genreMode||'single');option.disabled=roseTopicFilter(filters)&&['any','exclude'].includes(value);if(option.disabled)option.title='上游题材标签仅支持单选或同时匹配';mode.append(option);}mode.onchange=()=>{roseFilters[kind]={...filters,genreMode:mode.value,genre:mode.value==='single'?(filters.genre||'').split(',')[0]:filters.genre||'',sort:['any','exclude'].includes(mode.value)?'R':'U'};showRoseCatalog(kind,1);};choices.append(mode);}
        if(key!=='genre'){const more=roseButton(choices.classList.contains('collapsed')?'展开':'收起',()=>{choices.classList.toggle('collapsed');more.textContent=choices.classList.contains('collapsed')?'展开':'收起';more.setAttribute('aria-expanded',String(!choices.classList.contains('collapsed')));},'rose-filter-expand');more.setAttribute('aria-expanded',String(!choices.classList.contains('collapsed')));row.append(more);}
        panel.append(row);
    }
    const tools = document.createElement('div'); tools.className = 'rose-filter-tools';
    for (const [key,label,options] of [['sort','排序',[['R',roseAdvanced(filters)?'片库更新':'最近收录'],['N','新片优先'],['U','近期热门'],['S','评分最高']]], ['rating','评分',[['','全部评分'],['6','6 分以上'],['7','7 分以上'],['8','8 分以上'],['9','9 分以上'],['9.5','9.5 分以上']]],['quality','源标注画质',[['','全部'],['clear','排除抢先 / 枪版'],['hd','高清 / 蓝光'],['4k','4K / 2160P'],['1080','1080P'],['720','720P']]],['status','状态',[['','全部'],['finished','已完结'],['ongoing','连载中']]]]) {
        const wrap = document.createElement('label'); wrap.textContent = label + ' '; const select = document.createElement('select'); select.setAttribute('aria-label', label);
        for (const [value,text] of options) { const option = document.createElement('option'); option.value = value; option.textContent = text; option.selected = value === (filters[key] || (key === 'sort' ? roseAdvanced(filters)?'R':'U' : '')); select.append(option); }
        select.onchange = () => { roseFilters[kind] = { ...filters, [key]: select.value };if(key==='sort'&&select.value==='N'&&!filters.year)roseFilters[kind].year='近三年';showRoseCatalog(kind, 1); }; wrap.append(select); tools.append(wrap);
        if(key==='sort'&&roseAdvanced(filters)){select.value='R';select.disabled=true;select.title='组合类型、源标注画质和完结状态按来源更新顺序筛选';}
        if(['quality','status'].includes(key)&&roseTopicFilter(filters))for(const option of select.options||select.children){if(option.value&&!(key==='quality'&&option.value==='clear')){option.disabled=true;option.title='此资源筛选无法与题材标签精确组合';}}
        if(key==='quality'||key==='status')select.onchange=()=>{const next={...filters,[key]:select.value};if(roseAdvanced(next))next.sort='R';roseFilters[kind]=next;showRoseCatalog(kind,1);};
    }
    tools.append(roseButton(sessionStorage.getItem('roseExpandFilters')==='true'?'收起选项':'展开全部选项',()=>{sessionStorage.setItem('roseExpandFilters',sessionStorage.getItem('roseExpandFilters')==='true'?'false':'true');showRoseCatalog(kind,homeView.page||1,false);}));tools.append(roseButton('重置筛选', () => { roseFilters[kind] = {}; showRoseCatalog(kind, 1); })); panel.append(tools);
}
function roseAdvanced(filters){return !!(['any','exclude'].includes(filters.genreMode)&&filters.genre||(filters.quality&&filters.quality!=='clear')||filters.status);}
function roseCatalogPagination(kind,page,data,cursors){
    const pages=document.createElement('nav');pages.className='rose-pagination';pages.setAttribute('aria-label','影片分页');
    const known=Number.isInteger(data.pages)&&data.pages>0, sequential=Number.isInteger(data.nextCursor);
    const terminal=data.hasMore===false;
    const jumpMax=known?Math.min(10000,data.pages):sequential?Math.min(10000,data.hasMore===false?page:Math.max(page,cursors.length)):terminal?page:10000;
    const lastNumber=known?jumpMax:sequential?jumpMax:terminal?page:Math.min(10000,Math.max(7,page+3));
    const go=number=>{if(!Number.isInteger(number)||number<1||number>jumpMax){showToast(sequential?'组合筛选请先加载前面的页':'请输入 1～'+jumpMax+' 之间的页码','info');return;}if(number!==page)showRoseCatalog(kind,number);};
    const previous=roseButton('上一页',()=>go(page-1));previous.disabled=page<=1;pages.append(previous);
    const numbers=new Set([1]);
    for(let number=Math.max(1,page-3);number<=Math.min(lastNumber,Math.max(7,page+3));number++)numbers.add(number);
    if(known)numbers.add(jumpMax);
    let last=0;
    for(const number of [...numbers].sort((a,b)=>a-b)){
        if(number-last>1){const dots=document.createElement('span');dots.textContent='…';dots.setAttribute('aria-hidden','true');pages.append(dots);}
        const button=roseButton(String(number),()=>go(number));button.classList.toggle('selected',number===page);button.setAttribute('aria-label','第 '+number+' 页');if(number===page)button.setAttribute('aria-current','page');pages.append(button);last=number;
    }
    const next=roseButton('下一页',()=>go(page+1));next.disabled=data.hasMore===false||page>=jumpMax;pages.append(next);
    const jump=document.createElement('form'),input=document.createElement('input');input.type='number';input.min='1';input.max=String(jumpMax);input.placeholder='页码';input.setAttribute('aria-label','跳转页码');
    const submit=roseButton('跳转',()=>{});submit.type='submit';jump.append(input,submit);jump.onsubmit=event=>{event.preventDefault();go(Number(input.value));};jump.hidden=jumpMax<=1;pages.append(jump);
    const note=document.createElement('span');note.className='rose-pagination-summary';
    note.textContent=page===1&&!data.list?.length&&!data.hasMore?'第 1 页 · 暂无匹配内容':known?'第 '+page+' / '+data.pages+' 页':sequential?'第 '+page+' 批 · '+(data.hasMore?'按顺序加载后续结果':'当前条件已加载完毕'):'第 '+page+' 页 · '+(terminal?data.list?.length?'已到末页':'该页暂无结果，请返回前页或调整页码':'总页数未提供，可点击页码或直接跳页');
    pages.append(note);return pages;
}
async function roseCatalogRequest(address,options,status,retained=false){
    while(true){
        try{return await executeApiRequest(address,options);}
        catch(error){
            if(error.code!=='local_budget'||options.signal?.aborted)throw error;
            const end=Date.now()+error.retryAfterSeconds*1000+150;
            await new Promise((resolve,reject)=>{
                let timer;const abort=()=>{clearTimeout(timer);reject(Object.assign(new Error('已取消加载'),{name:'AbortError'}));};
                const tick=()=>{if(options.signal?.aborted){abort();return;}const left=Math.ceil((end-Date.now())/1000);if(left<=0){options.signal?.removeEventListener('abort',abort);resolve();return;}status.textContent='正在等待请求间隔，约 '+left+' 秒后自动继续；可以继续调整筛选'+(retained?'；仍显示上次已加载的结果':'');timer=setTimeout(tick,Math.min(1000,end-Date.now()));};
                options.signal?.addEventListener('abort',abort,{once:true});tick();
            });
            status.textContent='正在加载…'+(retained?'；仍显示上次已加载的结果':'');
        }
    }
}
function rosePrefetchNext(address,data,signal){
    if(!data.hasMore||Number.isInteger(data.nextCursor)||document.hidden)return;
    const current=Number(new URL(address).searchParams.get('page')),items=[];
    window.rosePrefetchTimer=setTimeout(async()=>{
        for(let page=current+1;page<=current+2;page++){
            if(signal.aborted||document.hidden)return;if(Number.isInteger(data.pages)&&page>data.pages)break;
            const next=new URL(address);next.searchParams.set('page',String(page));next.searchParams.set('prefetch','1');
            try{const result=await executeApiRequest(next.href,{timeoutSecs:10,signal});items.push(...result.list||[]);for(const item of result.list||[])roseRememberMetadata(item);if(result.hasMore===false)break;}catch{return;}
        }
        roseWarmPosters(items,signal);
    },250);
}
async function roseWarmPosters(items,signal){
    if(typeof fetch!=='function')return;
    const waiting=()=>[...document.querySelectorAll('.rose-poster-card img')].some(image=>image.dataset.roseImageState==='loading'||image.src&&!image.complete);
    for(let delay=0;delay<4000&&waiting()&&!signal.aborted;delay+=200)await new Promise(resolve=>setTimeout(resolve,200));
    if(signal.aborted||document.hidden||waiting())return;
    const urls=[...new Set(items.map(item=>item.vod_pic).filter(address=>/^https?:/.test(address||'')))].slice(0,48);let index=0;
    while(index<urls.length&&!signal.aborted&&!document.hidden){const address=urls[index++];try{const response=await fetch(address,{cache:'force-cache',priority:'low',signal});if(response.ok)await response.arrayBuffer();}catch{}}
}
window.showRoseCatalog = async (kind = 'home', page = 1, remember = true) => {
    roseStopBrowse();
    const controller=window.roseBrowseController=new AbortController();
    if (kind === 'home') return roseHome(remember,controller.signal);
    if (kind === 'favorites') return roseFavoritesPage(page);
    if (!roseKinds[kind]) kind = 'mv';
    const generation = ++homeGeneration, libraryGeneration = roseLibraryGeneration;
    if (remember && homeView.kind !== kind) { homeTrail.push({ ...homeView }); if (homeTrail.length > 12) homeTrail.shift(); }
    const limit = roseBrowseLimit(),filterKey=JSON.stringify(roseFilters[kind]||{}),sameFilters=homeView.kind===kind&&homeView.filterKey===filterKey&&homeView.limit===limit,cursors=sameFilters?homeView.cursors||[0]:[0],loadedPage=sameFilters?homeView.loadedPage||1:1;
    const container = document.getElementById('douban-recommendations-container'); if (!container) return;
    const retained=homeView.kind===kind&&homeView.loadedPage===homeView.page&&!!container.querySelector('.rose-pagination'),pendingView={ kind, page, limit,filterKey,cursors,loadedPage };
    if(!retained)homeView=pendingView;
    sessionStorage.setItem('roseFilters', JSON.stringify(roseFilters)); sessionStorage.setItem('roseCatalogState', JSON.stringify(homeView));
    initRoseBrowseStyle(); renderRoseBrowseNav();if(!retained)container.replaceChildren();
    container.querySelector('.rose-catalog-feedback')?.remove();
    if(!retained){const filterPanel=document.createElement('div');filterPanel.className='rose-filters';roseFilterRows(kind,filterPanel);container.append(filterPanel);}
    else if(!sameFilters){const filterPanel=container.querySelector('.rose-filters');filterPanel.replaceChildren();roseFilterRows(kind,filterPanel);}
    const status=retained?container.querySelector('.rose-library-status'):document.createElement('p');status.className='rose-library-status';status.setAttribute('role','status');status.textContent='正在加载第 '+page+' 页…'+(retained?'；仍显示上次已加载的结果':'');if(!retained)container.append(status);
    const grid=retained?container.querySelector('.rose-grid'):document.createElement('div');grid.className='rose-grid';if(!retained)container.append(grid);
    grid.setAttribute('aria-busy','true');
    const pendingButton=container.querySelector('.rose-pagination button[aria-label="第 '+page+' 页"]'),pageNote=container.querySelector('.rose-pagination-summary'),previousNote=pageNote?.textContent;
    pendingButton?.setAttribute('aria-busy','true');if(pageNote)pageNote.textContent='正在跳转到第 '+page+' 页…';
    window.isLoadingHomePageItems = true; window.noMoreHomePageTags = true;
    try {
        const bridge = await bridgeReady;
        const filters=Object.fromEntries(Object.entries(roseFilters[kind]||{}).filter(([key,value])=>value&&!(key==='genreMode'&&value==='single')));if(filters.genre)filters.genre=[...new Set(filters.genre.split(','))].sort().join(',');
        const query = new URLSearchParams({ kind, page: String(page), limit: String(limit),sort:'U', ...filters,details:'0',rich:'1' });if(roseAdvanced(roseFilters[kind]||{}))query.set('cursor',String(cursors[page-1]??(page-1)*limit*4));
        const address=bridge.url+'/library?'+query;
        if(cachedApiRequest(address)===undefined)await new Promise(resolve=>setTimeout(resolve,180));if(controller.signal.aborted)return;
        const data = await roseCatalogRequest(address, { timeoutSecs: roseAdvanced(roseFilters[kind]||{})?12:30,signal:controller.signal },status,retained);
        if (generation !== homeGeneration || libraryGeneration !== roseLibraryGeneration) return;
        if(!Array.isArray(data.list))throw new Error('目录接口没有返回有效列表，请稍后重试');
        if(page>1&&!data.list?.length&&data.hasMore===false&&!Number.isInteger(data.nextCursor)){const fallback=Number.isInteger(data.pages)?Math.min(page-1,data.pages):Math.min(page-1,loadedPage);showToast('第 '+page+' 页没有结果，已返回第 '+fallback+' 页','info');return showRoseCatalog(kind,fallback,false);}
        homeView=pendingView;grid.replaceChildren();
        if(data.list?.length){homeView.loadedPage=page;sessionStorage.setItem('roseCatalogState',JSON.stringify(homeView));}
        if(Number.isInteger(data.nextCursor)){cursors[page]=data.nextCursor;sessionStorage.setItem('roseCatalogState',JSON.stringify(homeView));}
        homeVideos.clear();
        for (const [index,item] of (data.list || []).entries()) {
            item.roseKind=kind;item.roseExcludeEarly=roseFilters[kind]?.quality==='clear';
            item.roseBatchMetadata=item.source_code==='metadata';
            roseRememberMetadata(item);
            homeVideos.set(item.source_code + ':' + item.vod_id, item);
            const card=rosePoster(item,()=>window.roseOpenVideo(item)),image=card.querySelector('img');
            if(image){image.loading=index<Math.ceil(limit/2)?'eager':'lazy';image.fetchPriority=index===0?'high':'auto';}
            grid.append(card);
        }
        const active=roseFilters[kind]||{};const conditions=[active.genre,active.year,active.region,active.lang,active.rating?'评分 ≥ '+active.rating:'',active.quality==='clear'?'排除抢先版':active.quality,active.status==='finished'?'已完结':active.status==='ongoing'?'连载中':''].filter(Boolean).join(' · ');
        const provider=data.provider==='豆瓣影片资料'?'影片资料库：豆瓣':data.provider?'资源片库：'+data.provider.replace(/\s*API$/,''):'';
        status.textContent = roseKinds[kind] + ' · 本页 ' + (data.list || []).length + ' 部' + (data.total ? ' / 共 ' + data.total + ' 部' : '') + (provider?' · '+provider:'') + (conditions?' · 当前条件：'+conditions:'') + (data.note ? ' · ' + data.note : '');
        if (!data.list?.length) status.textContent += data.unsupportedFilters?' · 当前组合无法由上游精确执行。':data.emptyReason==='language-index'?' · 这组语言标签未返回结果，不能据此判断全库没有这类影片。':data.hasMore?' · 这一批未找到匹配项，可继续下一页或调整筛选。':' · 资料源未返回匹配结果，可调整筛选。';
        if(data.emptyReason==='language-index')status.append(roseButton('取消语言筛选',()=>{roseFilters[kind]={...roseFilters[kind],lang:''};showRoseCatalog(kind,1);}));
        container.querySelector('.rose-pagination')?.remove();container.append(roseCatalogPagination(kind,page,data,cursors));
        const current=()=>generation===homeGeneration&&libraryGeneration===roseLibraryGeneration;
        if(data.metadataPending&&[...homeVideos.values()].some(item=>!item.vod_year||!item.vod_area||!roseMovieGenres(item).length)){
            const refresh=roseButton('补充本页资料',async()=>{if(window.roseCatalogMetadataPending){showToast('上一批资料仍在处理，请稍后再试');return;}refresh.disabled=true;
            const details=new URLSearchParams(query);details.set('details','1');details.set('background','1');
            try{const pending=window.roseCatalogMetadataPending=executeApiRequest(bridge.url+'/library?'+details,{timeoutSecs:40,signal:controller.signal});const enriched=await pending;if(current())for(const item of enriched?.list||[])roseRememberMetadata(item);}
            catch(error){if(!controller.signal.aborted)showToast(error.message,'error');}finally{window.roseCatalogMetadataPending=null;refresh.disabled=false;}
            });refresh.classList.add('rose-refresh-metadata');status.append(document.createTextNode(' · '),refresh);
        }
        if(!roseAdvanced(active))rosePrefetchNext(address,data,controller.signal);
    } catch (error) { if (generation === homeGeneration && !controller.signal.aborted) {
        const message='第 '+page+' 页加载失败：'+(error.message||'接口暂时不可用，请稍后重试');status.textContent=message+(retained?'；当前仍显示第 '+homeView.page+' 页。':'');
        const actions=document.createElement('div');actions.className='rose-catalog-feedback';actions.setAttribute('role','alert');
        if(retained){const note=document.createElement('span');note.textContent='第 '+page+' 页加载失败，已保留第 '+homeView.page+' 页。';actions.append(note);}
        actions.append(roseButton('重试第 '+page+' 页',()=>showRoseCatalog(kind,page,false)));if(!retained&&page>1)actions.append(roseButton('返回第 1 页',()=>showRoseCatalog(kind,1,false)));container.append(actions);
    } }
    finally {pendingButton?.removeAttribute('aria-busy');if(generation===homeGeneration){window.isLoadingHomePageItems=false;grid.removeAttribute('aria-busy');if(pageNote?.isConnected)pageNote.textContent=previousNote;}}
};
function roseMore(kind){roseFilters[kind]={sort:'U',year:'近三年'};roseNavigate('home',kind);}
function roseSection(title,kind){
    const section=document.createElement('section');section.className='rose-section';
    const head=document.createElement('div');head.className='rose-section-head';const heading=document.createElement('h2');heading.textContent=title;head.append(heading);
    if(kind){const more=roseButton('更多',()=>roseMore(kind),'rose-btn rose-more');more.append(window.roseIcon('next',16));head.append(more);}
    const grid=document.createElement('div');grid.className='rose-grid';section.append(head,grid);return{section,grid};
}
function roseDismissContinue(title){
    const hidden=JSON.parse(localStorage.getItem('roseHiddenContinue')||'{}');hidden[title]=Date.now();
    localStorage.setItem('roseHiddenContinue',JSON.stringify(Object.fromEntries(Object.entries(hidden).sort((a,b)=>b[1]-a[1]).slice(0,100))));
    roseHome(false);
}
async function roseHome(remember,signal){
    if(!signal){roseStopBrowse();signal=(window.roseBrowseController=new AbortController()).signal;}
    const generation=++homeGeneration;window.roseHomeObserver?.disconnect();
    if(remember&&homeView.kind!=='home')homeTrail.push({...homeView});
    const limit=roseBrowseLimit();homeView={kind:'home',page:1,limit};sessionStorage.setItem('roseCatalogState',JSON.stringify(homeView));
    const container=document.getElementById('douban-recommendations-container');if(!container)return;
    initRoseBrowseStyle();renderRoseBrowseNav();container.replaceChildren();homeVideos.clear();
    window.noMoreHomePageTags=true;window.isLoadingHomePageItems=true;
    const hidden=JSON.parse(localStorage.getItem('roseHiddenContinue')||'{}');
    const history=JSON.parse(localStorage.getItem('viewingHistory')||'[]').filter(item=>item.playbackPosition>10&&(!item.duration||item.playbackPosition<item.duration-30)&&(!hidden[item.title]||item.timestamp>hidden[item.title])).slice(0,4);
    if(history.length){const row=roseSection('继续观看');row.grid.className='rose-continue-grid';for(const item of history){const wrapper=document.createElement('div');wrapper.className='rose-continue-item';const button=roseButton('',()=>playFromHistory(item.url,item.title,item.episodeIndex||0,item.playbackPosition),'rose-continue-card');const title=document.createElement('strong');title.textContent=item.title;const note=document.createElement('small');note.textContent='第 '+((item.episodeIndex||0)+1)+' 集 · '+Math.floor(item.playbackPosition/60)+' 分 '+Math.floor(item.playbackPosition%60)+' 秒';const progress=document.createElement('progress');progress.max=item.duration||Math.max(item.playbackPosition,1);progress.value=item.playbackPosition;button.append(window.roseIcon('play',18),title,note,progress);const remove=roseButton('',()=>roseDismissContinue(item.title),'rose-continue-remove');remove.title='从继续观看中移除，保留历史记录';remove.setAttribute('aria-label','移除 '+item.title);remove.append(window.roseIcon('close',15));wrapper.append(button,remove);row.grid.append(wrapper);}container.append(row.section);}
    const sections=new Map();
    for(const kind of ['mv','tv','ac','variety','doc']){const row=roseSection('近期热门'+roseKinds[kind],kind);container.append(row.section);sections.set(kind,row);}
    const saved=window.roseHomeRows ||= new Map();
    function fill(kind,items,store=true){if(generation!==homeGeneration)return;if(store)saved.set(kind,{time:Date.now(),items});const row=sections.get(kind);row.grid.style.minHeight='';row.grid.replaceChildren();for(const item of items){homeVideos.set(item.source_code+':'+item.vod_id,item);row.grid.append(rosePoster(item,()=>window.roseOpenVideo(homeVideos.get(item.source_code+':'+item.vod_id)||item)));}if(!items.length){const p=document.createElement('p');p.className='rose-library-status';p.textContent='暂时没有推荐，点击更多查看';row.grid.append(p);}}
    for(const[kind,value]of saved)if(sections.has(kind))fill(kind,value.items,false);
    const bridge=await bridgeReady;
    const fresh=kind=>saved.has(kind)&&Date.now()-saved.get(kind).time<21600000,loadingKinds=new Set();
    const extra=async kind=>{if(fresh(kind)||signal.aborted||loadingKinds.has(kind))return;loadingKinds.add(kind);const row=sections.get(kind),loading=document.createElement('p');loading.className='rose-library-status';loading.textContent='正在加载…';if(!saved.has(kind))row.grid.replaceChildren(loading);try{const data=await roseCatalogRequest(bridge.url+'/library?'+new URLSearchParams({kind,page:'1',limit:String(limit),sort:'U',details:'0',rich:'1'}),{timeoutSecs:10,signal},loading);fill(kind,data.list||[]);}catch(error){if(signal.aborted||generation!==homeGeneration||saved.has(kind))return;row.grid.replaceChildren(roseButton('加载失败，重试',()=>extra(kind)));}finally{loadingKinds.delete(kind);}};
    for(const kind of ['tv','ac','variety','doc'])if(!saved.has(kind)){sections.get(kind).grid.style.minHeight='320px';sections.get(kind).grid.append(roseButton('加载近期热门'+roseKinds[kind],()=>extra(kind),'rose-load-section'));}
    await extra('mv');if(generation===homeGeneration)window.isLoadingHomePageItems=false;
    if(signal.aborted||generation!==homeGeneration||typeof IntersectionObserver==='undefined')return;
    const visible=new Set();let pumping=false;
    const pump=async()=>{if(pumping)return;pumping=true;try{while(visible.size&&!signal.aborted){const kind=visible.values().next().value;visible.delete(kind);await extra(kind);}}finally{pumping=false;}};
    window.roseHomeObserver=new IntersectionObserver(entries=>{for(const entry of entries){const kind=entry.target.roseKind;if(entry.isIntersecting&&!fresh(kind))visible.add(kind);else visible.delete(kind);}pump();},{rootMargin:'0px'});
    for(const[kind,row]of sections)if(kind!=='mv'&&!fresh(kind)){row.section.roseKind=kind;window.roseHomeObserver.observe(row.section);}
}
function roseSaved(){return JSON.parse(localStorage.getItem('roseFavorites')||'[]');}
function roseFavoriteKey(item){return roseNormalize(item.vod_name)+'|'+(item.vod_year||'');}
function roseFavoritesMatch(a,b){return Number(a.vod_douban_id)>0&&Number(b.vod_douban_id)>0?String(a.vod_douban_id)===String(b.vod_douban_id):roseFavoriteKey(a)===roseFavoriteKey(b);}
function roseRefreshFavorite(button){const saved=roseSaved().some(row=>roseFavoritesMatch(row,button.roseMovieItem));button.setAttribute('aria-pressed',String(saved));button.title=saved?'取消收藏':'收藏';button.setAttribute('aria-label',button.title+' '+button.roseMovieItem.vod_name);}
window.roseRefreshFavorites=()=>{for(const button of document.querySelectorAll('.rose-card-favorite'))roseRefreshFavorite(button);};
function roseToggleFavorite(item){
    const rows=roseSaved(),index=rows.findIndex(row=>roseFavoritesMatch(row,item));
    if(index>=0)rows.splice(index,1);else rows.unshift(Object.fromEntries(['vod_id','vod_douban_id','vod_name','vod_year','vod_area','vod_class','vod_pic','source_code','type_name'].map(key=>[key,item[key]||''])));
    localStorage.setItem('roseFavorites',JSON.stringify(rows.slice(0,200)));roseRefreshFavorites();if(window.roseEmbedded)parent.roseRefreshFavorites?.();else document.getElementById('rosePlayerFrame')?.contentWindow?.rosePlayerExtras?.();return index<0;
}
function roseFavoritesPage(page=1){
    roseResetPosters();
    ++homeGeneration;window.roseHomeObserver?.disconnect();homeView={kind:'favorites',page,limit:roseBrowseLimit()};sessionStorage.setItem('roseCatalogState',JSON.stringify(homeView));
    const container=document.getElementById('douban-recommendations-container');initRoseBrowseStyle();renderRoseBrowseNav();container.replaceChildren();
    const rows=roseSaved(),row=roseSection('我的收藏 · '+rows.length+' 部');
    for(const item of rows.slice((page-1)*homeView.limit,page*homeView.limit)){const wrapper=document.createElement('div');wrapper.className='rose-favorite-card';wrapper.append(rosePoster(item,()=>window.roseOpenVideo({...item,source_code:'metadata'})));const remove=roseButton('取消收藏',()=>{roseToggleFavorite(item);roseFavoritesPage(page);},'rose-remove-favorite');wrapper.append(remove);row.grid.append(wrapper);}
    if(!rows.length){const empty=document.createElement('p');empty.className='rose-library-status';empty.textContent='在播放页点击收藏，喜欢的影片就会出现在这里。';row.grid.append(empty);}container.append(row.section);
    if(rows.length>homeView.limit){const nav=document.createElement('div');nav.className='rose-pagination';const previous=roseButton('上一页',()=>roseFavoritesPage(page-1));previous.disabled=page<=1;const next=roseButton('下一页',()=>roseFavoritesPage(page+1));next.disabled=page*homeView.limit>=rows.length;nav.append(previous,document.createTextNode(page+' / '+Math.ceil(rows.length/homeView.limit)),next);container.append(nav);}
}
function roseNormalize(title) { return String(title).replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase(); }
function roseTitleIdentity(title,year='') {
    let text=String(title||'').normalize('NFKC').replace(/<[^>]*>/g,'').trim();
    let suffix=text.match(/(?:\s*[(（]?((?:19|20)\d{2})[)）]?)$/);
    if(suffix&&(suffix.index===0||Number(suffix[1])>new Date().getFullYear()+1))suffix=null;
    const released=String(year||'').match(/(?:19|20)\d{2}/)?.[0]||suffix?.[1]||'';
    if(suffix&&suffix[1]===released)text=text.slice(0,suffix.index);
    text=text.replace(/第([一二三四五六七八九十]|\d+)季/g,(_,n)=>'第'+({'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10}[n]||Number(n))+'季');
    return {title:roseNormalize(text),year:released};
}
function roseMatchVideo(item,title,year) {
    const wanted=roseTitleIdentity(title,year),actual=roseTitleIdentity(item.vod_name,item.vod_year);
    return actual.title===wanted.title&&(!wanted.year||!actual.year||actual.year===wanted.year);
}
function roseSearchScore(item,query) {
    const wanted=roseTitleIdentity(query),actual=roseTitleIdentity(item.vod_name,item.vod_year);
    if(actual.title===wanted.title)return wanted.year&&actual.year!==wanted.year?2:4;
    return actual.title.includes(wanted.title)?2:1;
}
function roseReliableSource(id) { const source=sourceInfo(id),test=JSON.parse(localStorage.getItem('roseSourceTests')||'{}')[id];return source&&!/暴风|bfzy/i.test(source.name+' '+source.url)&&!(test&&!test.apiAvailable&&Date.now()-test.time<1800000); }
function rosePreferredID() {
    return 'auto';
}
async function roseEnsureAPI() {
    if (typeof executeApiRequest !== 'function') await (window.roseAPIReady ||= new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='js/apiRequestCore.js';script.onload=resolve;script.onerror=reject;document.head.append(script);}));
}
async function roseFindVideo(sourceCode, title, year, reference={},onResponse,signal) {
    await roseEnsureAPI();
    const source = sourceInfo(sourceCode); if (!source) return null;
    let keyword=String(title).normalize('NFKC').trim();const suffix=keyword.match(/\s*[(（]?((?:19|20)\d{2})[)）]?$/);
    if(suffix&&suffix.index>0&&Number(suffix[1])<=new Date().getFullYear()+1&&(!year||String(year).includes(suffix[1])))keyword=keyword.slice(0,suffix.index);
    keyword=keyword.replace(/\s*第[一二三四五六七八九十百\d]+季\s*$/,'').trim();
    const data = await executeApiRequest(source.url + API_CONFIG.search.pagePath.replace('{query}',encodeURIComponent(keyword)).replace('{page}','1'), { headers: API_CONFIG.search.headers, timeoutSecs: 8,signal });
    onResponse?.(data);
    const wantedID=Number(reference.vod_douban_id||(reference.source_code==='metadata'?reference.vod_id:0))||0;
    const items = (data.list || []).filter(item => !isShortDrama(item)&&roseMatchVideo(item,title,year)&&(!wantedID||!Number(item.vod_douban_id)||Number(item.vod_douban_id)===wantedID));
    items.sort((a,b)=>(wantedID?Number(Number(b.vod_douban_id)===wantedID)-Number(Number(a.vod_douban_id)===wantedID):0)||(!year?Number(b.vod_year||0)-Number(a.vod_year||0):0)||resourceQuality(b).rank-resourceQuality(a).rank);
    if(wantedID&&!year&&!items.some(item=>Number(item.vod_douban_id)===wantedID)&&new Set(items.map(item=>roseTitleIdentity(item.vod_name,item.vod_year).year).filter(Boolean)).size>1)return null;
    return items[0] && { ...items[0], source_code: sourceCode };
}
async function roseVideoGroups(item,allowEarly=false,signal) {
    if (!item.vod_play_url) { const source = sourceInfo(item.source_code); if (!source) throw new Error('该来源已停用'); const data = await executeApiRequest((source.detail || source.url) + API_CONFIG.detail.path + encodeURIComponent(item.vod_id), { headers: API_CONFIG.detail.headers, timeoutSecs: 8,signal });const detail=data.list?.find(video=>String(video.vod_id)===String(item.vod_id));if(!detail)throw new Error('来源没有返回这部影片的详情');item = { ...item, ...detail }; }
    const earlyVersion=resourceQuality(item).rank<0;
    const direct = parsePlaybackGroups(item).filter(group=>group.direct).map(group=>earlyVersion?{...group,quality:-1}:group);
    const groups = direct.filter(group=>allowEarly||group.quality>=0);
    if (!groups.length) {const error=new Error(direct.length?'目前仅有 TC／抢先版，暂未找到清晰版':'当前来源没有可播放的直连线路');if(direct.length)error.earlyItem=item;throw error;}
    return { item, groups };
}
async function roseFindPlayable(ids,reference,allowEarly,signal,onEarly){
    const health=JSON.parse(localStorage.getItem('roseSourceTests')||'{}');ids=[...ids].sort((a,b)=>(health[b]?.score??-1)-(health[a]?.score??-1));
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();let cursor=0;
    try{return await Promise.any(Array.from({length:Math.min(2,ids.length)},async()=>{
        while(cursor<ids.length&&!controller.signal.aborted){const id=ids[cursor++];try{const candidate=await roseFindVideo(id,reference.vod_name,reference.vod_year,reference,null,controller.signal);if(!candidate)continue;return{candidate,resolved:await roseVideoGroups(candidate,allowEarly,controller.signal)};}catch(error){if(error.earlyItem)onEarly?.(error.earlyItem);}}
        throw new Error('没有匹配资源');
    }));}finally{signal?.removeEventListener('abort',abort);controller.abort();}
}
function roseOfferEarlyVersion(item) {
    document.getElementById('roseResourceNotice')?.remove();
    const notice=document.createElement('div');notice.id='roseResourceNotice';notice.setAttribute('role','status');
    const text=document.createElement('span');text.textContent=item.vod_name+'：目前查到的版本均标注为 TC／抢先版，画质可能较差。';
    notice.append(text,roseButton('仍然播放',()=>{notice.remove();roseOpenVideo({...item,roseAllowEarly:true});}),roseButton('关闭',()=>notice.remove()));document.body.append(notice);
}
window.roseOpenVideo = async item => {
    if(window.roseEmbedded){parent.roseOpenVideo(item);return;}
    const existing=roseExistingPlayerTab(item);if(existing){roseShowPlayer(existing.id);return;}if(rosePlayerTabs.length>=12){showToast('最多保留 12 个影片标签，请先关闭一个');return;}
    const generation = ++roseOpenGeneration;
    window.roseOpenController?.abort();const controller=window.roseOpenController=new AbortController();
    document.getElementById('roseResourceNotice')?.remove();
    try {
        await roseEnsureAPI();
        if(isShortDrama(item))throw new Error('已移除短剧内容，请选择电影或剧集');
        const preference = rosePreferredID();
        const allowEarly=!!item.roseAllowEarly&&!item.roseExcludeEarly;
        let chosen,resolved,earlyItem,lastError;
        const attempted=new Set();
        async function attempt(candidate) {
            if(!candidate||generation!==roseOpenGeneration)return false;
            const key=candidate.source_code+':'+candidate.vod_id;if(attempted.has(key))return false;attempted.add(key);
            try{resolved=await roseVideoGroups(candidate,allowEarly,controller.signal);chosen=candidate;return true;}catch(error){earlyItem ||= error.earlyItem;lastError=error;return false;}
        }
        if(preference!=='auto'&&preference!==item.source_code)await attempt(await roseFindVideo(preference,item.vod_name,item.vod_year,item).catch(()=>null));
        if(!resolved&&item.source_code!=='metadata')await attempt(item);
        if(!resolved){
            const seenURLs=new Set();const ids=JSON.parse(localStorage.getItem('selectedAPIs')||'[]').filter(id=>{const source=sourceInfo(id);if(!roseReliableSource(id)||seenURLs.has(source.url))return false;seenURLs.add(source.url);return id!==item.source_code;});
            for(const batch of [ids.filter(id=>id!=='site'),ids.filter(id=>id==='site')]){if(!batch.length||controller.signal.aborted)continue;try{const winner=await roseFindPlayable(batch,item,allowEarly,controller.signal,early=>earlyItem ||= early);chosen=winner.candidate;resolved=winner.resolved;break;}catch{}}
        }
        if(generation!==roseOpenGeneration||controller.signal.aborted)return;
        if(!resolved){if(earlyItem&&!item.roseExcludeEarly){roseOfferEarlyVersion({...item,...earlyItem,vod_name:item.vod_name});return;}throw lastError||new Error(earlyItem?'这部影片目前只找到抢先版，已按筛选条件排除；可以继续换源':'没有找到同片名、同年份的可播放版本；可更换关键词重试');}
        if (generation !== roseOpenGeneration) return;
        roseSavePlayerTab();
        currentEpisodes = resolved.groups[0].episodes.map(episode=>episode.url); currentVideoTitle = item.vod_name;
        roseRememberMetadata({...item,...resolved.item,vod_name:item.vod_name});
        sessionStorage.setItem('roseCurrentItem',JSON.stringify({...item,...resolved.item,vod_name:item.vod_name,vod_douban_id:item.vod_douban_id||resolved.item.vod_douban_id||''}));
        const early=resolved.groups[0].quality<0;
        sessionStorage.setItem('roseSelection',JSON.stringify({mode:early?'manual':preference==='auto'?'auto':'preferred',reason:early?'你允许播放现有的抢先版；当前来源暂无清晰版':preference==='auto'?'匹配同片名、年份和季数，最多同时查询两个来源，先播放可用的清晰直连资源；播放后不额外测速。点击此按钮可检查更清晰来源。':'优先使用设置中的来源；没有匹配资源时使用其他可用来源'}));
        sessionStorage.setItem('playbackLines',JSON.stringify({ title:item.vod_name, year:item.vod_year, sourceCode:chosen.source_code, groups:resolved.groups, allowEarly }));
        const history = JSON.parse(localStorage.getItem('viewingHistory') || '[]').find(entry=>entry.title===item.vod_name);
        const firstMain=resolved.groups[0].episodes.findIndex(episode=>!/预告|先导|花絮|纯享|加更|彩蛋|陪看|特辑|plus/i.test(episode.name));
        const index = Math.min(history?.episodeIndex ?? Math.max(0,firstMain),currentEpisodes.length-1);
        if (history?.playbackPosition) localStorage.setItem('videoProgress_'+currentEpisodes[index],JSON.stringify({position:history.playbackPosition,timestamp:Date.now()}));
        playVideo(currentEpisodes[index],item.vod_name,chosen.source_code,index);
        if(resolved.groups[0].quality<0)showToast('正在播放 TC／抢先版，当前来源尚无清晰版','warning');
    } catch (error) { if (generation === roseOpenGeneration) showToast(error.message || '资源加载失败，请重试','error'); }
};
window.showDetails = (id, title, sourceCode) => window.roseOpenVideo(getSearchVideo(sourceCode,id) || {vod_id:id,vod_name:title,source_code:sourceCode});
window.roseTryNextSource = async failed => {
    if(window.roseBrowsing)return false;
    await roseEnsureAPI();
    const generation = playerLoadGeneration;
    if (localStorage.getItem('roseAutoFallback') === 'false' || (window.roseFallbackCount || 0) >= 2) return false;
    window.roseFallbackCount = (window.roseFallbackCount || 0) + 1;
    const tried = window.roseTriedSources ||= new Set(); tried.add(failed);
    const lines = JSON.parse(sessionStorage.getItem('playbackLines') || '{}');
    const ids = JSON.parse(localStorage.getItem('selectedAPIs') || '[]').filter(id=>!tried.has(id) && roseReliableSource(id));
    const reference=JSON.parse(sessionStorage.getItem('roseCurrentItem')||'{}');
    window.roseFallbackController?.abort();const controller=window.roseFallbackController=new AbortController();
    try{for(const batch of [ids.filter(id=>id!=='site'),ids.filter(id=>id==='site')]){if(!batch.length||controller.signal.aborted)continue;try{const{candidate:item,resolved}=await roseFindPlayable(batch,{...reference,vod_name:currentVideoTitle,vod_year:lines.year},!!lines.allowEarly,controller.signal);if(generation!==playerLoadGeneration||window.roseBrowsing)return false;tried.add(item.source_code);sessionStorage.setItem('roseSelection',JSON.stringify({mode:'fallback',reason:'上一来源加载失败，自动切换到其他同片名、同年份的来源'}));window.roseAutomaticSwitch=true;try{selectRosePlayback(item.source_code,sourceInfo(item.source_code).name,resolved.groups,0,resolved.item);}finally{window.roseAutomaticSwitch=false;}showToast('已切换到 '+sourceInfo(item.source_code).name);return true;}catch{}}}finally{controller.abort();}
    return false;
};
// Probe at most two alternatives after a low-resolution stream has started; never scan the full source list.
function roseProbeResolution(address, signal, timeoutMs=3500) {
    return new Promise(resolve => {
        if(signal.aborted){resolve(null);return;}
        const started=Date.now();
        const video=document.createElement('video');video.muted=true;video.preload='metadata';
        let hls,done=false;
        const finish=result=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);for(const event of ['loadedmetadata','loadeddata','resize'])video.removeEventListener(event,measure);video.removeEventListener('error',cancel);hls?.destroy();video.pause();video.removeAttribute('src');video.load();resolve(result);};
        const cancel=()=>finish(null),measure=()=>{if(video.videoWidth&&video.videoHeight&&video.readyState>=2)finish({width:video.videoWidth,height:video.videoHeight,elapsedMs:Date.now()-started});};
        const timer=setTimeout(cancel,timeoutMs);signal.addEventListener('abort',cancel,{once:true});
        for(const event of ['loadedmetadata','loadeddata','resize'])video.addEventListener(event,measure);
        video.addEventListener('error',cancel,{once:true});
        try{
            const bridge=window.ROSETV_BRIDGE,url=bridge?.key&&!address.startsWith(bridge.url+'/')?bridge.mediaURL(address):address;
            if(!/\.mp4(?:[?#]|$)/i.test(address)&&typeof Hls!=='undefined'&&Hls.isSupported()){
                hls=new Hls({enableWorker:false,backBufferLength:0,maxBufferLength:1,maxMaxBufferLength:1,maxBufferSize:2*1024*1024,manifestLoadingTimeOut:timeoutMs-500,manifestLoadingMaxRetry:0,levelLoadingTimeOut:timeoutMs-500,levelLoadingMaxRetry:0,fragLoadingTimeOut:timeoutMs-500,fragLoadingMaxRetry:0,fetchSetup:(context,init)=>new Request(context.url,{...init,cache:'no-store'})});
                hls.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal)cancel();});hls.loadSource(url);hls.attachMedia(video);
            }else{video.src=url;video.load();}
        }catch{cancel();}
    });
}
window.roseCheckResolution=async(explicit=false)=>{
    if(!explicit)return;
    if(typeof dp==='undefined'||!dp?.video||window.roseBrowsing)return;
    await roseEnsureAPI();
    if(window.roseBrowsing)return;
    const video=dp.video,selection=JSON.parse(sessionStorage.getItem('roseSelection')||'{}');
    if(selection.mode!=='auto'||!video.videoWidth||Math.max(video.videoWidth,video.videoHeight)>=1920)return;
    const reference=JSON.parse(sessionStorage.getItem('roseCurrentItem')||'{}'),key=currentVideoTitle+'|'+(reference.vod_year||'');
    if(window.roseQualityAttempt===key)return;window.roseQualityAttempt=key;
    window.roseQualityCheck?.abort();const controller=new AbortController();window.roseQualityCheck=controller;
    const timer=setTimeout(()=>controller.abort(),8000);
    try{
        const current=new URLSearchParams(location.search).get('source_code'),seen=new Set([sourceInfo(current)?.url]);
        const ids=JSON.parse(localStorage.getItem('selectedAPIs')||'[]').filter(id=>{const source=sourceInfo(id);if(id==='site'||!roseReliableSource(id)||seen.has(source.url))return false;seen.add(source.url);return true;});
        ids.sort((a,b)=>(a==='rose_hn'?0:a==='site'?1:2)-(b==='rose_hn'?0:b==='site'?1:2));
        const pending=ids.slice(0,2).map((id,index)=>({index,task:roseFindVideo(id,currentVideoTitle,reference.vod_year,reference,null,controller.signal).then(async item=>item?{item,...await roseVideoGroups(item,false,controller.signal)}:null).catch(()=>null).then(result=>({index,result}))}));
        let best,checked=0;
        const cancelled=new Promise(resolve=>controller.signal.addEventListener('abort',()=>resolve(null),{once:true}));
        while(pending.length&&!controller.signal.aborted){
            const ready=await Promise.race([...pending.map(row=>row.task),cancelled]);if(!ready)break;
            pending.splice(pending.findIndex(task=>task.index===ready.index),1);
            if(!ready.result)continue;
            const candidate=ready.result;checked++;const lineNames=new Set();
            const lines=candidate.groups.map((group,index)=>({group,index})).filter(({group})=>{const key=group.name||group.episodes[0]?.url;if(lineNames.has(key))return false;lineNames.add(key);return true;}).slice(0,2);
            for(const {index:line} of lines){
                if(controller.signal.aborted)break;
                const index=roseEpisodeIndex(candidate.groups,line);if(index<0)continue;
                const address=candidate.groups[line].episodes[index].url;if(currentEpisodes.includes(address))continue;
                const measured=await roseProbeResolution(address,controller.signal),baseline=best?.measured||{width:video.videoWidth,height:video.videoHeight};
                if(measured&&measured.width*measured.height>baseline.width*baseline.height*1.2){best={...candidate,measured,line};if(Math.max(measured.width,measured.height)>=1920)break;}
            }
            if(best&&Math.max(best.measured.width,best.measured.height)>=1920)break;
        }
        if(dp.video!==video||window.roseBrowsing)return;
        if(!best){selection.reason='当前实测 '+video.videoWidth+'×'+video.videoHeight+'；已有限检查 '+checked+' 个候选，暂未确认更清晰且能及时加载的同片资源，保留当前播放。未遍历全部线路。';sessionStorage.setItem('roseSelection',JSON.stringify(selection));rosePlayerExtras();return;}
        const reason='实测由 '+video.videoWidth+'×'+video.videoHeight+' 提升至 '+best.measured.width+'×'+best.measured.height+'；最多检查两个候选来源，未遍历全部线路';
        sessionStorage.setItem('roseSelection',JSON.stringify({mode:'auto',reason}));window.roseAutomaticSwitch=true;
        try{selectRosePlayback(best.item.source_code,sourceInfo(best.item.source_code).name,best.groups,best.line,best.item);}finally{window.roseAutomaticSwitch=false;}
        showToast('已优选实测更清晰的来源：'+best.measured.width+'×'+best.measured.height);
    }finally{clearTimeout(timer);controller.abort();if(window.roseQualityCheck===controller)window.roseQualityCheck=null;}
};
window.addEventListener?.('pagehide',()=>window.roseQualityCheck?.abort());
function roseContentNames() {
    const filter=document.getElementById('yellowFilterToggle');
    const row=filter?.closest('.flex.flex-col');
    const label=row?.querySelector('label'); if(label) label.textContent='内容过滤';
    const note=row?.querySelector('.filter-description'); if(note) note.textContent='过滤成人影片分类，保留普通影视内容';
    const adult=document.getElementById('customApiIsAdult');
    const adultLabel=adult?.parentElement.querySelector('label'); if(adultLabel)adultLabel.textContent='此来源包含成人影片分类';
}
function roseSourceSummary(result){
    if(result.testVersion!==2)return result.playable?result.width+'×'+result.height+' · '+result.score+' 分 · 旧版样片':'旧版测试，请重新检测';
    const tested=(result.samples||[]).filter(row=>!row.skipped),skipped=5-tested.length;
    if(!result.apiAvailable)return (tested[0]?.message||'接口检测失败')+(skipped?' · 其余 '+skipped+' 项未测':'');
    const prefix=result.passed+'/'+tested.length+' 个样片可播';
    if(result.playable)return prefix+' · 最低 '+result.width+'×'+result.height+' · 首帧 '+(result.startMs/1000).toFixed(1)+' 秒 · '+result.score+' 分';
    const missing=tested.filter(row=>/未找到|未收录/.test(row.message)).length;
    return prefix+' · '+(missing===tested.length?'接口可用，未收录这些样片':'有样片未匹配或未取得首帧');
}
function roseCompactSources() {
    const grid=document.getElementById('normaldiv');if(!grid)return;
    grid.querySelector('.api-group-title')?.remove();for(const row of [...grid.children])if(row.querySelector('input')?.dataset.api==='site')row.remove();
    const results=JSON.parse(localStorage.getItem('roseSourceTests')||'{}');
    const rows=[...grid.children].filter(row=>row.querySelector('input'));
    rows.sort((a,b)=>(results[b.querySelector('input').dataset.api]?.score??-1)-(results[a.querySelector('input').dataset.api]?.score??-1));
    for(const row of rows){const id=row.querySelector('input').dataset.api,label=row.querySelector('label'),result=results[id];row.querySelector('.rose-public-remove')?.remove();if(id.startsWith('rose_public_')){const remove=roseButton('移除',event=>{event.preventDefault();event.stopPropagation();removeCustomApi(Number(id.slice(12)));},'rose-public-remove');remove.setAttribute('aria-label','移除自定义来源 '+API_SITES[id].name);row.append(remove);}label.textContent=API_SITES[id]?.name||id;if(result){const note=document.createElement('small');note.className='rose-source-result';note.textContent=roseSourceSummary(result);label.append(note);row.title=result.message+' · '+new Date(result.time).toLocaleString();}grid.append(row);}
    roseContentNames();
}
function roseAccountPanel(){
    const box=document.createElement('div');box.className='rose-account-panel';const description=document.createElement('p');description.textContent='在网站正常登录并完成验证后，点击“保存登录状态”连接到 RoseTV。优先使用默认的 Chrome / Edge 类浏览器打开专用窗口；其他浏览器使用 Edge 登录组件。各域名分别保存会话，登录有效期由网站决定。';const status=document.createElement('p');status.className='rose-account-status';status.textContent='正在读取登录状态…';const actions=document.createElement('div');
    async function request(path){const bridge=await bridgeReady;const response=await fetch(bridge.url+path,{method:'POST',headers:{'X-RoseTV-Key':bridge.key}});const data=await response.json();if(!response.ok)throw new Error(data.error||'操作失败，请重试');return data;}
    const login=roseButton('登录 / 更换账号',async()=>{login.disabled=true;status.textContent='正在打开网站登录窗口…';try{status.textContent=(await request('/account/login')).message;}catch(error){status.textContent=error.message;}finally{login.disabled=false;}});
    const save=roseButton('保存登录状态',async()=>{save.disabled=true;status.textContent='正在验证登录状态…';try{const data=await request('/account/save');ROSETV_BRIDGE.site=true;API_SITES.site={name:'教父资源',api:ROSETV_BRIDGE.url};selectedAPIs=[...new Set([...JSON.parse(localStorage.getItem('selectedAPIs')||'[]'),'site'])];localStorage.setItem('selectedAPIs',JSON.stringify(selectedAPIs));const toggle=document.querySelector('#customApisList input[data-api=site]');if(toggle)toggle.checked=true;updateSelectedApiCount();status.textContent=data.message;}catch(error){status.textContent=error.message;}finally{save.disabled=false;}});
    const visit=roseButton('在默认浏览器查看网站',async()=>{try{status.textContent=(await request('/account/visit')).message;}catch(error){status.textContent=error.message;}});actions.append(login,save,visit);box.append(description,actions,status);
    bridgeReady.then(async bridge=>{try{const response=await window.__TAURI_INTERNALS__.invoke('make_http_request',{options:{url:bridge.url+'/account/status',method:'GET',headers:{'X-RoseTV-Key':bridge.key},timeout_secs:3}});if(response.status!==200)return;const data=JSON.parse(response.body);if(box.isConnected)status.textContent=data.enabled?'已保存加密会话；有效期由网站决定，遇到验证请手动完成':'尚未登录，请先登录后保存';}catch{if(box.isConnected)status.textContent='暂时无法读取账号状态';}});
    return box;
}
async function roseLocalRequest(path,method='GET',data){const bridge=await bridgeReady;const response=await fetch(bridge.url+path,{method,headers:{'X-RoseTV-Key':bridge.key,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});const value=await response.json();if(!response.ok)throw new Error(value.error||'操作失败，请重试');return value;}
function roseProviderPanel(){
    const box=document.createElement('div');box.className='rose-provider-editor';const title=document.createElement('h3');title.textContent='网站地址';const main=document.createElement('input');main.type='url';main.setAttribute('aria-label','主用网站地址');main.placeholder='https://主用网站';const backups=document.createElement('textarea');backups.rows=5;backups.setAttribute('aria-label','备用网址，每行一个');backups.placeholder='备用网址，每行一个';const message=document.createElement('p');message.className='rose-setting-note';
    const save=roseButton('保存地址',async()=>{save.disabled=true;try{const data=await roseLocalRequest('/provider/save','POST',{primary:main.value,backups:backups.value.split(/\n/).map(v=>v.trim()).filter(Boolean)});const account=await roseLocalRequest('/account/status');ROSETV_BRIDGE.site=account.enabled;message.textContent=account.saved?'地址已保存，已复用此域名保存的登录状态。':'地址已保存。此域名首次使用需单独登录并保存，其他域名的登录状态仍保留。';main.value=data.primary;backups.value=data.backups.join('\n');const status=box.parentElement?.querySelector('.rose-account-status');if(status)status.textContent=message.textContent;}catch(error){message.textContent=error.message;}finally{save.disabled=false;}});
    const refresh=roseButton('从发布页更新地址',async()=>{refresh.disabled=true;try{const data=await roseLocalRequest('/provider/refresh','POST');main.value=data.primary;backups.value=data.backups.join('\n');message.textContent=data.discovery?.message||'地址已检查';}catch(error){message.textContent=error.message;}finally{refresh.disabled=false;}});
    const label1=document.createElement('label');label1.textContent='主用地址';label1.append(main);const label2=document.createElement('label');label2.textContent='备用网址';label2.append(backups);box.append(title,label1,label2,save,refresh,message);roseLocalRequest('/provider').then(data=>{main.value=data.primary;backups.value=data.backups.join('\n');message.textContent='连接故障时每天最多检查一次可信发布页。验证或限流时停止检查；新域名仍需单独登录。'+(data.discovery?.message||'');}).catch(error=>message.textContent=error.message);return box;
}
function roseRenderSiteCustom(){
    const container=document.getElementById('customApisList');if(!container)return;container.replaceChildren();
    const row=document.createElement('div');row.className='rose-site-source';const toggle=document.createElement('input');toggle.type='checkbox';toggle.dataset.api='site';toggle.checked=JSON.parse(localStorage.getItem('selectedAPIs')||'[]').includes('site');toggle.onchange=()=>updateSelectedAPIs();
    const words=document.createElement('span'),name=document.createElement('strong'),note=document.createElement('small');name.textContent='教父资源';note.textContent='账号网站 · 使用本机加密登录会话';words.append(name,note);const edit=roseButton('修改',()=>{editor.hidden=!editor.hidden;edit.setAttribute('aria-expanded',String(!editor.hidden));},'rose-source-edit');edit.setAttribute('aria-expanded','false');row.append(toggle,words,edit);const editor=document.createElement('div');editor.className='rose-site-editor';editor.hidden=true;editor.append(roseAccountPanel(),roseProviderPanel());container.append(row,editor);
}
function roseSourceScore(sample,queryMs){const edge=Math.max(sample.width,sample.height),quality=edge>=3840?50:edge>=1920?42:edge>=1280?30:edge>=640?15:5;return Math.round(quality+Math.max(0,35-sample.elapsedMs/150)+Math.max(0,15-queryMs/100));}
async function roseSourceSamples(signal){
    if(signal?.aborted)throw Object.assign(new Error('已停止检测'),{name:'AbortError'});
    const items=[['mv','肖申克的救赎','1994'],['tv','大明王朝1566','2007'],['ac','千与千寻','2001'],['variety','明星大侦探 第一季','2016'],['doc','地球脉动 第一季','2006']].map(([kind,title,year])=>({kind,label:roseKinds[kind],item:{vod_name:title,vod_year:year,source_code:'metadata'}}));
    localStorage.setItem('roseSourceSamples',JSON.stringify({version:2,time:Date.now(),items}));return items;
}
window.roseRunSourceTests=async()=>{
    if(window.roseSourceTestController)return;
    await roseEnsureAPI();if(typeof Hls==='undefined')await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='libs/hls.min.js';script.onload=resolve;script.onerror=reject;document.head.append(script);});
    const controller=new AbortController();window.roseSourceTestController=controller;
    const ids=Object.keys(API_SITES).filter(id=>id!=='site'&&!id.startsWith('rose_public_')&&!API_SITES[id].adult),results={};let cursor=0,finished=0,sampleFinished=0;
    const status=document.getElementById('roseSourceTestStatus'),button=document.getElementById('roseSourceTestButton'),stopButton=document.getElementById('roseSourceStopButton');if(button)button.disabled=true;if(stopButton)stopButton.disabled=false;
    async function worker(samples){while(cursor<ids.length&&!controller.signal.aborted){const id=ids[cursor++],checks=[];for(const target of samples){if(controller.signal.aborted)break;const started=Date.now(),check={kind:target.kind,label:target.label,title:target.item.vod_name,rating:target.item.vod_douban_score,time:Date.now(),apiAvailable:false,playable:false,score:0};try{const video=await roseFindVideo(id,target.item.vod_name,target.item.vod_year,target.item,data=>check.apiAvailable=Array.isArray(data.list),controller.signal);if(!video)throw new Error('该来源未找到同片、同年份与季数的样片');const resolved=await roseVideoGroups(video,false,controller.signal);check.queryMs=Date.now()-started;const episode=resolved.groups[0].episodes.find(row=>!/预告|花絮|先导|纯享|加更|特辑/i.test(row.name))||resolved.groups[0].episodes[0];const decoded=await roseProbeResolution(episode.url,controller.signal,8000);if(!decoded)throw new Error('8 秒内未取得解码首帧');Object.assign(check,{playable:true,width:decoded.width,height:decoded.height,startMs:decoded.elapsedMs,score:roseSourceScore(decoded,check.queryMs),message:'首帧解码通过'});}catch(error){check.message=error.message||'检测失败';}if(controller.signal.aborted)break;checks.push(check);sampleFinished++;if(!check.apiAvailable){checks.push(...samples.slice(checks.length).map(target=>({kind:target.kind,label:target.label,title:target.item.vod_name,apiAvailable:false,playable:false,score:0,skipped:true,message:'接口首测失败，本轮未重复请求'})));break;}if(status)status.textContent='已测 '+sampleFinished+'/'+(ids.length*5)+' 个样片 · '+target.label+'：'+target.item.vod_name;}
        if(controller.signal.aborted)break;const passed=checks.filter(row=>row.playable),minimum=passed.slice().sort((a,b)=>a.width*a.height-b.width*b.height)[0];results[id]={testVersion:2,time:Date.now(),samples:checks,passed:passed.length,apiAvailable:checks.some(row=>row.apiAvailable),playable:passed.length>0,score:Math.round(checks.reduce((sum,row)=>sum+row.score,0)/5),width:minimum?.width,height:minimum?.height,startMs:passed.length?Math.round(passed.reduce((sum,row)=>sum+row.startMs,0)/passed.length):0,message:checks.map(row=>row.label+'：'+row.title+' · '+(row.playable?row.width+'×'+row.height+' / '+(row.startMs/1000).toFixed(1)+' 秒':row.message)).join('\n')};finished++;localStorage.setItem('roseSourceTests',JSON.stringify(results));roseCompactSources();
    }}
    try{if(status)status.textContent='正在准备五类固定样片…';const samples=await roseSourceSamples(controller.signal);if(controller.signal.aborted)return results;await Promise.all([worker(samples),worker(samples)]);if(!controller.signal.aborted){const top=Object.entries(results).filter(([,result])=>result.playable).sort((a,b)=>b[1].score-a[1].score).slice(0,5).map(([id])=>id);const custom=JSON.parse(localStorage.getItem('selectedAPIs')||'[]').filter(id=>!ids.includes(id));selectedAPIs=[...custom,...top];localStorage.setItem('selectedAPIs',JSON.stringify(selectedAPIs));initAPICheckboxes();roseRenderSiteCustom();updateSelectedApiCount();if(status)status.textContent='检测完成：'+ids.length+' 个来源，'+Object.values(results).filter(row=>row.apiAvailable).length+' 个接口可用，'+Object.values(results).reduce((sum,row)=>sum+row.passed,0)+'/'+sampleFinished+' 个分类样片通过；已选择前 '+top.length+' 名，可手动多选。';}else if(status)status.textContent+=' · 已停止';return results;}
    catch(error){if(status)status.textContent='测试未完成：'+(error.message||'请稍后重试')+'；保留原来源选择。';throw error;}
    finally{controller.abort();window.roseSourceTestController=null;if(button)button.disabled=false;if(stopButton)stopButton.disabled=true;}
};
function roseSourceTestControls(){const box=document.createElement('div');box.className='rose-source-tests';const actions=document.createElement('div'),button=roseButton('测试全部内置来源',()=>roseRunSourceTests().catch(error=>showToast(error.message,'error')));button.id='roseSourceTestButton';const stop=roseButton('停止测试',()=>window.roseSourceTestController?.abort());stop.id='roseSourceStopButton';stop.disabled=!window.roseSourceTestController;actions.append(button,stop);const status=document.createElement('p');status.id='roseSourceTestStatus';const saved=Object.values(JSON.parse(localStorage.getItem('roseSourceTests')||'{}'));status.textContent=(saved.length?'上次测试：'+new Date(Math.max(...saved.map(row=>row.time))).toLocaleString()+' · '+saved.filter(row=>row.apiAvailable).length+' 个接口可用，'+saved.reduce((sum,row)=>sum+(row.testVersion===2?row.passed:Number(row.playable)),0)+'/'+saved.reduce((sum,row)=>sum+(row.testVersion===2?5:1),0)+' 个样片通过。 ':'')+'抽样检测分辨率和首帧耗时，完成后选择前 5 名。分数由画质（50）、起播速度（35）、接口响应（15）组成；电影、剧集、动漫、综艺、纪录片各取一部固定常见样片，不额外查询豆瓣，失败样片记零分，五项等权平均；仍不代表整个片库。';box.append(actions,status);return box;}
function roseBytes(bytes){if(bytes<1024)return bytes+' B';if(bytes<1048576)return(bytes/1024).toFixed(1)+' KiB';return(bytes/1048576).toFixed(2)+' MiB';}
function roseShowCacheLocation(data){const path=document.getElementById('roseCachePath');if(!path)return;path.textContent=(data.pending||data.current||'正在读取…')+(data.restartRequired?' · 重启后生效':'');path.title=path.textContent;if(data.error)path.textContent+=' · '+data.error;}
function roseCacheLocationRow(){const row=document.createElement('div');row.className='rose-cache-location';const words=document.createElement('span'),title=document.createElement('strong'),path=document.createElement('small');title.textContent='缓存位置';path.id='roseCachePath';path.textContent='正在读取…';words.append(title,path);const change=roseButton('',async()=>{change.disabled=true;change.textContent='选择中…';try{const response=await window.__TAURI_INTERNALS__.invoke('make_http_request',{options:{url:ROSETV_BRIDGE.url+'/cache-location/choose',method:'GET',headers:{'X-RoseTV-Key':ROSETV_BRIDGE.key},timeout_secs:300}});if(response.status!==200)throw new Error('更改失败，请检查文件夹权限后重试');const data=JSON.parse(response.body);roseShowCacheLocation(data);if(!data.cancelled)showToast('缓存位置已保存，重启 RoseTV 后生效');}catch(error){showToast(error.message,'error');}finally{change.disabled=false;change.replaceChildren(roseIcon('folder',16),document.createTextNode('更改文件夹'));}});change.append(roseIcon('folder',16),document.createTextNode('更改文件夹'));row.append(words,change);return row;}
async function roseStorage(){
    const target=document.getElementById('roseStorageStats');if(!target)return;target.textContent='正在统计本机文件…';
    try{
        const bridge=await bridgeReady;const invoke=window.__TAURI_INTERNALS__.invoke;
        const response=await invoke('make_http_request',{options:{url:bridge.url+'/storage',method:'GET',headers:{'X-RoseTV-Key':bridge.key},timeout_secs:5}});
        if(response.status!==200)throw new Error('无法读取存储情况，请重试');const data=JSON.parse(response.body);
        const settingsBytes=new Blob([JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)])))]).size;
        target.replaceChildren();
        for(const [label,value]of [['磁盘总占用',roseBytes(data.totalDiskBytes||0)],['程序文件',roseBytes(data.applicationBytes)],['应用浏览器数据（含缓存）',roseBytes(data.profileBytes)],['其中：应用浏览器缓存',roseBytes(data.browserCacheBytes)],['专用网站登录窗口数据',roseBytes(data.accountBrowserBytes||0)],['其中：扩展与组件包',roseBytes(data.accountBrowserExtensionBytes||0)],['其中：网站存储（含离线数据）',roseBytes(data.accountBrowserSiteStorageBytes||0)],['其中：登录浏览器缓存',roseBytes(data.accountBrowserCacheBytes||0)],['目录快照文件（最多 8 MiB）',roseBytes(data.savedMetadataBytes||0)],['本地配置与账号文件',roseBytes(data.configurationBytes||0)],['后端接口缓存（内存）',roseBytes(data.metadataBytes)+' · '+data.metadataEntries+' 项'],['前端接口缓存（内存估算）',roseBytes(typeof apiCacheBytes==='undefined'?0:apiCacheBytes)],['设置与记录（已含在浏览器数据）',roseBytes(settingsBytes)]]){const row=document.createElement('div');const name=document.createElement('span');name.textContent=label;const amount=document.createElement('strong');amount.textContent=value;row.append(name,amount);target.append(row);}
        const time=document.createElement('small');time.textContent='测量时间：'+new Date(data.measuredAt*1000).toLocaleTimeString();target.append(time);if(data.cacheLocation)roseShowCacheLocation(data.cacheLocation);
    }catch(error){target.textContent=error.message||'读取失败，请刷新重试';}
}
function roseSettings() {
    const page=document.getElementById('page-settings');if(!page||document.getElementById('roseSettingsWorkspace'))return;
    const sourceCard=document.getElementById('apiCheckboxes').closest('.p-3');
    const customCard=document.getElementById('customApisList').closest('.p-3');
    const filterRow=document.getElementById('yellowFilterToggle')?.closest('.flex.flex-col');
    const configButtons=[...page.querySelectorAll('button[onclick]')].filter(button=>/^(importConfig|exportConfig)/.test(button.getAttribute('onclick')));
    const head=document.createElement('header');head.className='rose-settings-header';
    const title=document.createElement('h1');title.textContent='设置';const subtitle=document.createElement('p');subtitle.textContent='让 RoseTV 按你的习惯播放';head.append(title,subtitle);
    const workspace=document.createElement('div');workspace.id='roseSettingsWorkspace';workspace.className='rose-settings-workspace';
    const side=document.createElement('nav');side.className='rose-settings-sidebar';side.setAttribute('aria-label','设置分类');
    const main=document.createElement('div');main.className='rose-settings-main';
    const panes={};
    for(const [id,label,icon] of [['playback','播放与体验','play'],['appearance','外观','sun'],['sources','播放来源','series'],['storage','存储与配置','settings']]){
        const button=roseButton('',()=>{for(const [key,pane]of Object.entries(panes))pane.hidden=key!==id;for(const b of side.children)b.classList.toggle('selected',b===button);window.scrollTo(0,0);if(id==='storage')roseStorage();},'rose-settings-tab');const caption=document.createElement('span');caption.textContent=label;button.append(window.roseIcon(icon,18),caption);button.dataset.section=id;side.append(button);
        const pane=document.createElement('section');pane.className='rose-settings-pane';pane.hidden=id!=='playback';panes[id]=pane;main.append(pane);if(id==='playback')button.classList.add('selected');
    }
    panes.appearance.append(roseAppearancePanel());
    const card=document.createElement('div');card.className='rose-preference-card';
    const heading=document.createElement('h2');heading.textContent='播放偏好';card.append(heading);
    localStorage.setItem('rosePreferredSource','auto');localStorage.removeItem('rosePreferredSourceURL');
    const label=document.createElement('div');label.className='rose-preference-field';label.textContent='播放策略';const policy=document.createElement('strong');policy.textContent='自动优选';const policyNote=document.createElement('small');policyNote.textContent='在“播放来源”勾选的范围内选择可播放的同片资源。';label.append(policy,policyNote);card.append(label);
    const refreshOptions=()=>{};
    function toggleRow(text,description,key,defaultValue){const row=document.createElement('label');row.className='rose-preference-toggle';const words=document.createElement('span');const name=document.createElement('strong');name.textContent=text;const note=document.createElement('small');note.textContent=description;words.append(name,note);const toggle=document.createElement('input');toggle.type='checkbox';toggle.checked=localStorage.getItem(key)===null?defaultValue:localStorage.getItem(key)==='true';toggle.onchange=()=>localStorage.setItem(key,toggle.checked);row.append(words,toggle);card.append(row);}
    toggleRow('失败后自动换源','当前来源不可用时，尝试其他清晰资源','roseAutoFallback',true);
    toggleRow('连续播放下一集','剧集播放结束后自动开始下一集','autoplayEnabled',true);
    if(filterRow){filterRow.className='rose-content-filter flex flex-col';card.append(filterRow);}
    const note=document.createElement('p');note.className='rose-setting-note';note.textContent='单击封面直接播放。没有多档画质的来源只显示实际分辨率。推荐复用 30 分钟，公开目录复用 6 小时；账号接口最多 1 个并发，请求间隔至少 2 秒，遇限流暂停 15 分钟。';card.append(note);panes.playback.append(card);
    const sourceIntro=document.createElement('div');sourceIntro.className='rose-section-intro';sourceIntro.textContent='内置来源是不需要账号的公开 API。勾选后参与搜索；可抽样测试并按播放质量排序。';panes.sources.append(sourceIntro,sourceCard,customCard);
    sourceCard.querySelector('label.block').textContent='内置来源';sourceCard.prepend(roseSourceTestControls());if(customCard.querySelector('label.block'))customCard.querySelector('label.block').textContent='自定义来源';
    const addPublic=customCard.querySelector('button[onclick="showAddCustomApiForm()"]'),addPublicForm=customCard.querySelector('#addCustomApiForm');if(addPublic&&addPublicForm){const count=sourceCard.querySelector('#selectedApiCount'),actions=count.closest('div');actions.className='rose-source-actions';const label=count.parentElement;label.replaceChildren(document.createTextNode('已选来源：'),count);label.title='包含内置与自定义来源';label.setAttribute('aria-live','polite');addPublic.textContent='添加公开 API';addPublic.className='rose-add-public';actions.append(addPublic);sourceCard.append(actions,addPublicForm);}
    for(const button of sourceCard.querySelectorAll('button[onclick^="selectAllAPIs"]'))button.remove();
    customCard.querySelector('label')?.replaceChildren(document.createTextNode('自定义来源'));
    const storage=document.createElement('div');storage.className='rose-preference-card';
    const storageTitle=document.createElement('h2');storageTitle.textContent='缓存与存储';
    const stats=document.createElement('div');stats.id='roseStorageStats';stats.className='rose-storage-stats';stats.textContent='点击刷新查看当前占用';
    const text=document.createElement('p');text.className='rose-setting-note';text.textContent='总占用按运行文件、两类浏览器资料、目录快照和本地配置的实际磁盘文件统计，子项不重复相加，不含开发备份与系统共享浏览器组件。专用登录窗口用于正常登录和完成网站验证，与日常浏览器资料分开；其中的 Cookie、网站存储和缓存不全是登录必需数据。清理接口缓存保留账号与记录，下次首次访问可能稍慢。目录快照最多 8 MiB，影片资料最多 512 KiB；视频不保存为电影文件。';
    const actionsStorage=document.createElement('div');actionsStorage.className='rose-setting-actions';
    const clear=roseButton('清理接口缓存',async()=>{try{clear.disabled=true;const response=await fetch(ROSETV_BRIDGE.url+'/clear-cache?_k='+ROSETV_BRIDGE.key,{credentials:'include'});if(!response.ok)throw new Error('清理失败，请重试');apiCache.clear();apiCacheBytes=0;await roseStorage();showToast('接口缓存已清理，观看记录和账号会话已保留');}catch(error){showToast(error.message,'error');}finally{clear.disabled=false;}},'rose-primary-button');actionsStorage.append(roseButton('刷新占用',()=>roseStorage()),clear);storage.append(storageTitle,roseCacheLocationRow(),stats,text,actionsStorage);panes.storage.append(storage);
    const config=document.createElement('div');config.className='rose-preference-card';const configTitle=document.createElement('h2');configTitle.textContent='配置备份';const actions=document.createElement('div');actions.className='rose-setting-actions';actions.append(...configButtons);config.append(configTitle,actions);panes.storage.append(config);
    workspace.append(side,main);page.replaceChildren(head,workspace);roseCompactSources();
    const oldCheck=window.checkAdultAPIsSelected;window.checkAdultAPIsSelected=()=>{oldCheck();roseContentNames();};
    const oldInit=window.initAPICheckboxes;window.initAPICheckboxes=()=>{rosePrepareSources();oldInit();roseCompactSources();refreshOptions();};
    window.renderCustomAPIsList=()=>{rosePrepareSources();initAPICheckboxes();roseRenderSiteCustom();refreshOptions();};
    window.updateSelectedAPIs=()=>{selectedAPIs=[...document.querySelectorAll('#normaldiv input[data-api]:checked,#customApisList input[data-api]:checked')].map(input=>input.dataset.api);localStorage.setItem('selectedAPIs',JSON.stringify(selectedAPIs));updateSelectedApiCount();refreshOptions();};
    roseRenderSiteCustom();initAPICheckboxes();
}
window.roseRefreshHome = () => {
    if (location.pathname.includes('player.html')) return;
    delete API_SITES.testSource;
    if (typeof selectedAPIs !== 'undefined') { selectedAPIs=selectedAPIs.filter(id=>id!=='testSource');localStorage.setItem('selectedAPIs',JSON.stringify(selectedAPIs)); }
    const originalAdult = window.addAdultAPI;
    window.addAdultAPI = () => { if (Object.values(API_SITES).some(source=>source.adult)) originalAdult(); else document.getElementById('adultdiv')?.remove(); };
    rosePrepareSources();initAPICheckboxes(); window.addAdultAPI();
    roseSettings(); document.getElementById('bottomNav')?.remove();
    if (sessionStorage.getItem('activeTab')==='filter') sessionStorage.setItem('activeTab','home');
    if (sessionStorage.getItem('activeTab')==='home' || !sessionStorage.getItem('activeTab')) { const saved=homeView.kind; showRoseCatalog(saved || 'home', homeView.page || 1, false); }
    const query=sessionStorage.getItem('roseSearchQuery');if(query){sessionStorage.removeItem('roseSearchQuery');document.getElementById('searchInput').value=query;navigateToTab('search');search();}
};

if(typeof navigateToTab==='function'){
    const navigate=window.navigateToTab;
    window.navigateToTab=(page,kind)=>{if(page==='filter'){window.roseGoHome();return;}roseStopBrowse();window.roseOpenController?.abort();if(page!=='search')window.cancelSearchLoad?.();if(page!=='settings')window.roseSourceTestController?.abort();roseHidePlayer();navigate(page,false);renderRoseBrowseNav();if(page==='home'&&typeof homeView!=='undefined')showRoseCatalog(kind||homeView.kind,kind?1:homeView.page||1,false);if(page==='settings'){roseContentNames();requestAnimationFrame(()=>window.scrollTo(0,0));}};
}
if(typeof showVideoPlayer==='function'){
    const navigatePlayer=window.showVideoPlayer;
    window.showVideoPlayer=address=>{const url=new URL(address,location.href);const id=url.searchParams.get('source_code');const source=id&&sourceInfo(id);if(source)url.searchParams.set('source',source.name);const progress=JSON.parse(localStorage.getItem('videoProgress_'+url.searchParams.get('url'))||'{}');if(progress.position>0)url.searchParams.set('position',progress.position);if(!location.pathname.includes('player.html'))roseStartPlayer(url.href);else navigatePlayer(url.href);};
}
function roseSourceName(id){if(id==='site')return'教父资源';const source=id?.startsWith('custom_')?JSON.parse(localStorage.getItem('customAPIs')||'[]')[Number(id.slice(7))]:API_SITES[id];return source?.name||id||'未知来源';}
function roseText(html){return new DOMParser().parseFromString(String(html||'').slice(0,30000),'text/html').body.textContent.trim();}
function roseMovieGenres(item){
    const generic=new Set(['其它','其他','未知','未分类','电影','电视剧','剧集','动漫','综艺','短剧','伦理片','伦理']);
    const aliases={'动画电影':'动画','动漫电影':'动画','记录':'纪录','纪录片':'纪录','记录片':'纪录'};
    const genres=[];
    for(const token of String(item.vod_class||'').replace(/<[^>]*>/g,'').split(/[,，、/|\s]+/)){
        const value=aliases[token]||token.replace(/片$/,'');if(value&&!generic.has(token)&&!generic.has(value))genres.push(value);
    }
    if(!genres.length){const raw=String(item.type_name||'').trim();const value=aliases[raw]||raw.replace(/片$/,'');if(raw&&!generic.has(raw)&&!generic.has(value)&&!/^(?:电视|连续|国产|欧美|香港|台湾|日本|韩国|海外|泰国|港澳|韩|日|美)剧$|综艺|动漫|动画剧集/.test(value))genres.push(value);}
    return [...new Set(genres)];
}
function roseVideoKind(item){
    if(item.roseKind&&roseKinds[item.roseKind])return item.roseKind;
    const type=String(item.type_name||'');
    if(/纪录|记录/.test(type))return 'doc';if(/综艺|真人秀|脱口秀/.test(type))return 'variety';if(/动漫电影|动画电影|动画片/.test(type))return 'mv';if(/动漫|动画剧集/.test(type))return 'ac';
    return /电视剧|连续剧|剧集|国产剧|欧美剧|香港剧|台湾剧|日本剧|韩国剧|海外剧|泰国剧|港澳剧|韩剧|日剧|美剧/.test(type)?'tv':'mv';
}
window.roseBrowseGenre=(item,genre)=>{
    if(window.roseEmbedded){parent.roseBrowseGenre(item,genre);return;}
    const kind=roseVideoKind(item);roseFilters[kind]={genre,genreMode:'single',sort:'S'};
    sessionStorage.setItem('roseFilters',JSON.stringify(roseFilters));roseNavigate('home',kind);
};
function roseDownloadLinks(item){
    const links=[];const seen=new Set();
    const add=(name,address,kind='下载链接',code='')=>{if(typeof address!=='string'||! /^(https?:\/\/|magnet:\?xt=urn:btih:|ed2k:\/\/|thunder:\/\/)/i.test(address)||seen.has(address))return;seen.add(address);links.push({name:String(name||'下载资源').slice(0,220),url:address,kind,code});};
    const groups=(item.vod_down_from||'').split('$$$');String(item.vod_down_url||'').split('$$$').forEach((group,index)=>group.split('#').forEach(entry=>{const split=entry.indexOf('$');if(split>=0)add([groups[index],entry.slice(0,split)].filter(Boolean).join(' · '),entry.slice(split+1));}));
    const torrents=item.site_resources?.downlist?.list;
    if(torrents&&Array.isArray(torrents.m))torrents.m.forEach((hash,index)=>{if(/^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(hash))add([torrents.t?.[index]||'磁力资源',torrents.s?.[index]].filter(Boolean).join(' · '),'magnet:?xt=urn:btih:'+hash,'磁力资源');});
    const pans=item.site_resources?.panlist;
    if(pans&&Array.isArray(pans.url))pans.url.forEach((address,index)=>add(pans.name?.[index]||'网盘资源',address,'网盘资源',pans.p?.[index]||''));
    let budget=200;
    const visit=(value,name,depth)=>{if(--budget<0||depth>6)return;if(typeof value==='string'){const matches=value.match(/(?:magnet:\?xt=urn:btih:|ed2k:\/\/|thunder:\/\/|https?:\/\/)[^\s<>"']+/g)||[];for(const address of matches)if(!address.startsWith('http')||/pan\.|drive\.|aliyundrive|alipan|quark|115\.com|\.torrent(?:[?#]|$)/i.test(address))add(name,address);}else if(Array.isArray(value))value.slice(0,50).forEach((child,index)=>visit(child,name+' '+(index+1),depth+1));else if(value&&typeof value==='object')for(const[key,child]of Object.entries(value))visit(child,value.name||value.title||value.t||key,depth+1);};
    for(const[key,value]of Object.entries(item.site_resources||{}))if(!['downlist','panlist','playlist'].includes(key))visit(value,'来源下载',0);return links;
}
function roseRenderMovieInfo(panel,item,loading=false){
    panel.replaceChildren();const caption=document.createElement('small');caption.className='rose-film-caption';caption.textContent='影片信息';const heading=document.createElement('h2');heading.textContent=item.vod_name||currentVideoTitle||'影片信息';panel.append(caption,heading);
    const fields=document.createElement('dl');fields.className='rose-film-fields';
    const genreRow=document.createElement('div'),genreName=document.createElement('dt'),genreValues=document.createElement('dd');genreName.textContent='类型';genreValues.className='rose-film-genres';
    const genres=roseMovieGenres(item);for(const genre of genres){const button=roseButton(genre,()=>roseBrowseGenre(item,genre),'rose-genre-link');button.title='查看'+genre+'类型的'+roseKinds[roseVideoKind(item)];button.setAttribute('aria-label',button.title);genreValues.append(button);}
    if(!genres.length)genreValues.textContent=loading?'正在补充类型…':'来源未提供具体类型';genreRow.append(genreName,genreValues);fields.append(genreRow);
    for(const[label,value]of [['导演',item.vod_director||'来源未提供'],['演员',item.vod_actor||'来源未提供'],['年代',item.vod_year],['地区',item.vod_area],['语言',item.vod_lang],['评分',Number(item.vod_douban_score)>0?item.vod_douban_score:'']])if(value){const row=document.createElement('div'),name=document.createElement('dt'),text=document.createElement('dd');name.textContent=label;text.textContent=roseText(value).replace(/[,，]/g,' / ');row.append(name,text);fields.append(row);}panel.append(fields);
    const synopsis=document.createElement('p');synopsis.className='rose-film-synopsis';synopsis.textContent=roseText(item.vod_content||item.vod_blurb)||(loading?'正在读取演员与简介…':'当前来源没有提供简介');panel.append(synopsis);
    const note=document.createElement('small');note.className='rose-film-note';note.textContent='影片资料：'+(item.roseInfoProvider||roseSourceName(item.source_code))+(item.roseGenreProvider?' · 类型：'+item.roseGenreProvider:'');panel.append(note);
    const downloads=document.createElement('section');downloads.className='rose-downloads';const title=document.createElement('h3');title.textContent='下载资源';downloads.append(title);
    const links=roseDownloadLinks(item);
    for(const kind of [...new Set(links.map(link=>link.kind))]){
        const rows=links.filter(link=>link.kind===kind),group=document.createElement('details');group.className='rose-download-group';
        const summary=document.createElement('summary');summary.textContent=kind+' · '+rows.length+' 项 · 展开查看';group.append(summary);
        let shown=0;const list=document.createElement('div');list.className='rose-download-list';group.append(list);
        const actions=document.createElement('div');actions.className='rose-download-actions';
        const more=roseButton('加载更多',()=>appendRows()),copyAll=roseButton('复制此组全部链接',()=>navigator.clipboard.writeText(rows.map(link=>link.url+(link.code?'\n提取码：'+link.code:'')).join('\n')).then(()=>showToast('已复制此组 '+rows.length+' 条链接','success')));
        function appendRows(){for(const link of rows.slice(shown,shown+20)){const row=document.createElement('div');row.className='rose-download-row';const label=document.createElement('span');label.textContent=link.name+(link.code?' · 提取码：'+link.code:'');const copy=roseButton('复制链接',()=>navigator.clipboard.writeText(link.url+(link.code?'\n提取码：'+link.code:'')).then(()=>showToast('下载链接已复制，使用下载工具打开','success')).catch(()=>showToast('复制失败，请重试')));row.append(label,copy);list.append(row);}shown=Math.min(rows.length,shown+20);more.textContent='加载更多 · 已显示 '+shown+'/'+rows.length;more.hidden=shown>=rows.length;}
        actions.append(more,copyAll);group.append(actions);group.addEventListener('toggle',()=>{summary.textContent=kind+' · '+rows.length+' 项'+(group.open?'':' · 展开查看');if(group.open&&!shown)appendRows();});downloads.append(group);
    }
    if(links.length){const total=document.createElement('p');total.textContent='共 '+links.length+' 条来源提供的链接；每次展开加载 20 条，不自动下载。文件名、年份和版本以来源标注为准，请核对后选择。';downloads.append(total);}
    if(!links.length){const empty=document.createElement('p');empty.textContent=loading?'正在检查来源提供的下载信息…':'当前接口未提供可直接复制的下载链接。在线播放画质与下载文件画质可能不同。';downloads.append(empty);}
    if(item.site_detail_url){const row=document.createElement('div');const label=document.createElement('span');label.textContent='网盘、磁力与不同版本的完整资源';const copy=roseButton('复制来源详情网址',()=>navigator.clipboard.writeText(item.site_detail_url).then(()=>showToast('来源详情网址已复制','success')));row.append(label,copy);downloads.append(row);}
    panel.append(downloads);
}
function roseLoadMovieInfo(){
    let panel=document.getElementById('roseMovieInfo');if(!panel){panel=document.createElement('section');panel.id='roseMovieInfo';document.querySelector('main').append(panel);}
    let item=JSON.parse(sessionStorage.getItem('roseCurrentItem')||'{}');if(item.vod_name!==currentVideoTitle)item={vod_name:currentVideoTitle,source_code:new URLSearchParams(location.search).get('source_code')};
    const title=currentVideoTitle,key=title+'|'+(item.vod_year||'')+'|'+new URLSearchParams(location.search).get('source_code')+'|'+(item.vod_id||'')+'|'+Number(!!item.site_resources);
    if(window.roseInfoKey===key)return;window.roseInfoKey=key;
    const complete=()=>!!(item.vod_actor&&item.vod_content&&roseMovieGenres({...item,type_name:''}).length);
    window.roseInfoController?.abort();
    roseRememberMetadata(item);roseRenderMovieInfo(panel,item);if(complete())return;
    const supplement=roseButton('补充影片资料',async()=>{
        supplement.disabled=true;const controller=window.roseInfoController=new AbortController();
        try{
        await bridgeReady;await roseEnsureAPI();const seen=new Set();
        const ids=JSON.parse(localStorage.getItem('selectedAPIs')||'[]').filter(id=>{const source=sourceInfo(id);if(id==='site'||!roseReliableSource(id)||seen.has(source.url))return false;seen.add(source.url);return true;});
        const priority=id=>/360zy/.test(sourceInfo(id).url)?0:/mdzyapi/.test(sourceInfo(id).url)?1:2;ids.sort((a,b)=>priority(a)-priority(b));
        for(const id of ids.slice(0,2))try{
            if(controller.signal.aborted)return;
            let found=await roseFindVideo(id,title,item.vod_year,item,null,controller.signal);if(!found)continue;
            if(!found.vod_content&&!found.vod_actor&&!found.vod_class)found=(await roseVideoGroups(found,true,controller.signal)).item;
            if(controller.signal.aborted||window.roseInfoKey!==key||currentVideoTitle!==title)return;
            for(const field of ['vod_actor','vod_director','vod_content','vod_blurb','vod_year','vod_area','vod_lang','vod_douban_score'])if(!item[field]&&found[field])item[field]=found[field];
            if(!roseMovieGenres({...item,type_name:''}).length&&roseMovieGenres({...found,type_name:''}).length){item.vod_class=found.vod_class;item.roseGenreProvider=roseSourceName(id);}
            roseRememberMetadata(item);sessionStorage.setItem('roseCurrentItem',JSON.stringify(item));roseRenderMovieInfo(panel,item,!complete());if(complete())break;
        }catch{}
        if(!controller.signal.aborted&&window.roseInfoKey===key&&currentVideoTitle===title){roseRenderMovieInfo(panel,item);if(!complete())panel.append(supplement);}
        }finally{supplement.disabled=false;}
    });panel.append(supplement);
}
window.roseSyncNativeFullscreen=enabled=>{
    if(window.roseEmbedded)return parent.roseSyncNativeFullscreen(enabled);
    document.documentElement?.classList.toggle('rose-screen-fullscreen',enabled);
    if(window.roseNativeFullscreen===enabled)return window.roseFullscreenPending||Promise.resolve();
    window.roseNativeFullscreen=enabled;
    return window.roseFullscreenPending=(window.roseFullscreenPending||Promise.resolve()).catch(()=>{}).then(async()=>{
        const bridge=await bridgeReady,response=await fetch(bridge.url+'/window/fullscreen?enabled='+(enabled?'1':'0'),{headers:{'X-RoseTV-Key':bridge.key}});
        if(!response.ok){window.roseNativeFullscreen=undefined;throw new Error('无法切换屏幕全屏，请重试');}
    });
};
document.addEventListener('fullscreenchange',()=>window.roseSyncNativeFullscreen(!!document.fullscreenElement).catch(error=>showToast(error.message,'error')));
window.roseBindPlayerWindows=player=>{
    if(player.roseWindowsBound)return;player.roseWindowsBound=true;
    player.on('fullscreen',()=>window.roseSyncNativeFullscreen(true).catch(error=>showToast(error.message,'error')));
    player.on('fullscreen_cancel',()=>window.roseSyncNativeFullscreen(false).catch(error=>showToast(error.message,'error')));
    const controls=player.container.querySelector('.dplayer-icons-right');if(!controls)return;
    const button=roseButton('',async()=>{try{
        if(document.pictureInPictureElement){await document.exitPictureInPicture();return;}
        if(player.video.readyState<2)throw new Error('请等待影片开始播放后再打开小窗');
        if(document.fullscreenElement)await document.exitFullscreen();await window.roseSyncNativeFullscreen(false);
        await player.video.requestPictureInPicture();
    }catch(error){showToast(error.message||'暂时无法打开播放小窗','error');}},'dplayer-icon rose-pip-button');
    button.title='播放小窗，可拖动并拖拽边缘调整大小';button.setAttribute('aria-label','播放小窗');button.setAttribute('aria-pressed','false');button.append(window.roseIcon('pip',20));
    button.disabled=!document.pictureInPictureEnabled||!player.video.requestPictureInPicture;
    controls.prepend(button);
    let pipPlaying=false;
    const rememberPlayback=()=>queueMicrotask(()=>{if(document.pictureInPictureElement===player.video)pipPlaying=!player.video.paused;});
    for(const type of ['play','pause'])player.video.addEventListener(type,rememberPlayback);
    player.video.addEventListener('enterpictureinpicture',()=>{pipPlaying=!player.video.paused;button.setAttribute('aria-pressed','true');});
    player.video.addEventListener('leavepictureinpicture',()=>{
        button.setAttribute('aria-pressed','false');if(player.video.isConnected===false)return;
        const owner=window.roseEmbedded?parent:window;owner.roseResumePlayback=pipPlaying;owner.roseShowPlayer?.();if(!window.roseEmbedded)window.roseResumeFromBrowse?.(pipPlaying);
        Promise.resolve(owner.bridgeReady).then(bridge=>fetch(bridge.url+'/window/focus',{headers:{'X-RoseTV-Key':bridge.key}})).catch(()=>{});
    });
};
window.rosePlayerExtras=()=>{
    if(typeof dp==='undefined'||!dp?.video)return;
    window.roseBindPlayerWindows(dp);
    const bar=document.getElementById('playbackQualityBar');if(!bar)return;
    const params=new URLSearchParams(location.search),id=params.get('source_code');
    const selection=JSON.parse(sessionStorage.getItem('roseSelection')||'{"mode":"auto","reason":"按来源提供的画质标注和直连顺序选择，未对全部来源逐一测速"}');
    let policy=document.getElementById('roseSelectionPolicy');if(!policy){policy=document.createElement('button');policy.id='roseSelectionPolicy';bar.append(policy);}
    policy.textContent=({auto:'自动优选',preferred:'偏好来源',fallback:'自动换源',manual:'手动选择'})[selection.mode]||'当前来源';
    policy.title=selection.reason+' · 点击检查更清晰来源';policy.onclick=()=>{showToast(selection.reason);window.roseCheckResolution(true).catch(error=>showToast(error.message,'error'));};
    const sourceButton=[...bar.querySelectorAll('button')].find(button=>button.textContent.includes('换源')&&button!==policy);if(sourceButton)sourceButton.textContent=roseSourceName(id)+' · 换源';
    const line=bar.querySelector('select[aria-label="切换播放线路"]');if(line)for(const option of line.options)if(!option.textContent.startsWith('线路：'))option.textContent='线路：'+option.textContent;
    let favorite=document.getElementById('roseFavoriteButton');if(!favorite){favorite=roseButton('',()=>{const item=JSON.parse(sessionStorage.getItem('roseCurrentItem')||'null')||{vod_name:currentVideoTitle,source_code:id};roseToggleFavorite(item);rosePlayerExtras();},'rose-player-favorite');favorite.id='roseFavoriteButton';bar.append(favorite);}
    const item=JSON.parse(sessionStorage.getItem('roseCurrentItem')||'null')||{vod_name:currentVideoTitle};const saved=roseSaved().some(row=>roseFavoritesMatch(row,item));favorite.replaceChildren(window.roseIcon('star',16),document.createTextNode(saved?'已收藏':'收藏'));favorite.setAttribute('aria-pressed',String(saved));
    roseLoadMovieInfo();
};
if(typeof playbackQualityControls==='function'){
    const controls=window.playbackQualityControls;window.playbackQualityControls=(...args)=>{controls(...args);window.rosePlayerExtras();};
}
if(typeof selectRosePlayback==='function'){
    const select=window.selectRosePlayback;window.selectRosePlayback=(...args)=>{window.roseQualityCheck?.abort();if(!window.roseAutomaticSwitch)sessionStorage.setItem('roseSelection',JSON.stringify({mode:'manual',reason:'你手动选择了此来源或线路'}));return select(...args);};
}
if(typeof exportConfig==='function')window.exportConfig=async()=>{
    const keys=['selectedAPIs','customAPIs','yellowFilterEnabled','viewingHistory',SEARCH_HISTORY_KEY,'rosePreferredSource','rosePreferredSourceURL','roseAutoFallback','rosePlaybackRate','autoplayEnabled','roseSourcesAdded','siteProviderAdded','roseFavorites','roseHiddenContinue','roseTheme','roseAccent'];
    const data=Object.fromEntries(keys.map(key=>[key,localStorage.getItem(key)]).filter(([,value])=>value!==null));
    const config={name:'RoseTV-Settings',time:String(Date.now()),cfgVer:'1.0.0',data,hash:await sha256(JSON.stringify(data))};
    saveStringAsFile(JSON.stringify(config),'RoseTV-Settings_'+config.time+'.json');
};
if(location.pathname.includes('player.html'))document.addEventListener('keydown',event=>{
    if(event.altKey||event.ctrlKey||event.metaKey||event.target.closest?.('input,textarea,select,button,[contenteditable=true]')||!dp?.video)return;
    const key=event.key.toLowerCase();
    if(key==='f'){event.preventDefault();dp.fullScreen.toggle();}
    if(key==='m'){event.preventDefault();dp.video.muted=!dp.video.muted;}
    if(key==='['||key===']'){event.preventDefault();dp.video.playbackRate=Math.max(.5,Math.min(3,Math.round((dp.video.playbackRate+(key===']' ? .25 : -.25))*4)/4));playbackQualityControls(dp.video,currentHls,true);}
});

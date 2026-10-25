// Shared deadlines, connection results and JSON handling for all API callers.
const apiCache = new Map();
const apiPending = new Map();
let apiCacheBytes = 0;
async function executeApiRequest(apiUrl, options = {}) {
    if(window.roseExecuteApiRequest)return window.roseExecuteApiRequest(apiUrl,options);
    const { method = 'GET', headers = {}, timeoutSecs = 6, asText = false } = options;
    const parsed = new URL(apiUrl);
    if(parsed.hostname==='www.hongniuzy2.com'&&parsed.searchParams.get('ac')==='videolist'){parsed.searchParams.set('ac','detail');apiUrl=parsed.href;}
    if (!/^https?:$/.test(new URL(apiUrl).protocol)) throw new Error('无效的资源地址');
    const key = JSON.stringify([method, apiUrl, headers, asText]);
    const cached = apiCache.get(key);
    if (method === 'GET' && cached && Date.now() - cached.time < 300000) return cached.data;
    if (apiPending.has(key)) return apiPending.get(key);
    const controller = new AbortController();
    let timer;
    const request = (async () => {
        let body;
        const invoke = typeof tauriConstants !== 'undefined' ? tauriConstants.invoke : window.__TAURI_INTERNALS__?.invoke;
        if (invoke) {
            const bridge = window.ROSETV_BRIDGE;
            const pooled = bridge?.enabled && method === 'GET';
            const requestUrl = pooled && !apiUrl.startsWith(bridge.url + '/')
                ? bridge.url + '/http?url=' + encodeURIComponent(apiUrl) : apiUrl;
            const requestHeaders = pooled ? { ...headers, 'X-RoseTV-Key': bridge.key } : headers;
            const response = await invoke('make_http_request', {
                options: { url: requestUrl, method, headers: requestHeaders, timeout_secs: timeoutSecs }
            });
            if (response.status < 200 || response.status >= 300) {
                let message;try{message=JSON.parse(response.body).error;}catch{}
                throw new Error(typeof message==='string'?message:'资源接口返回 '+response.status);
            }
            body = response.body;
        } else {
            const response = await fetch(apiUrl, { method, headers, signal: controller.signal });
            if (!response.ok) throw new Error('资源接口返回 ' + response.status);
            body = await response.text();
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
        if (method === 'GET') {
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
    }).finally(() => { clearTimeout(timer); apiPending.delete(key); });
    apiPending.set(key, pending);
    return pending;
}

function sourceInfo(id) {
    const api = id.startsWith('custom_') ? JSON.parse(localStorage.getItem('customAPIs') || '[]')[Number(id.slice(7))] : API_SITES[id];
    return api && { name: api.name, url: api.url || api.api, detail: api.detail };
}
function isShortDrama(item) {
    return /短剧|爽文|反转爽文|脑洞悬疑|女频恋爱|年代穿越|古装仙侠|现代都市|成长逆袭|言情总裁|都市脑洞/.test(item.type_name||'');
}
function resourceQuality(item) {
    const text = [item.vod_name, item.vod_remarks, item.vod_version].join(' ');
    if (/\b(?:TC|TS|CAM)\b|枪版|抢先|偷拍/i.test(text)) return { rank: -1, label: '抢先 / 枪版' };
    if (/2160|\b4K\b|\bUHD\b/i.test(text)) return { rank: 2160, label: '源标注 4K' };
    if (/1080|\bFHD\b/i.test(text)) return { rank: 1080, label: '源标注 1080P' };
    if (/720/i.test(text)) return { rank: 720, label: '源标注 720P' };
    if (/480|360P/i.test(text)) return { rank: 480, label: '源标注 标清' };
    return { rank: 0, label: /蓝光|高清|\bHD\b/i.test(text) ? '源标注高清 · 分辨率未知' : '清晰度未标注' };
}

function parsePlaybackGroups(video) {
    const names = (video.vod_play_from || '').split('$$$');
    return (video.vod_play_url || '').split('$$$').map((group, index) => {
        const episodes = group.split('#').map(entry => {
            const separator = entry.indexOf('$');
            const name = separator >= 0 ? entry.slice(0, separator) : '';
            const url = separator >= 0 ? entry.slice(separator + 1).trim() : entry.trim();
            try {
                if (!/^https?:$/.test(new URL(url).protocol)) return null;
            } catch { return null; }
            return { name, url };
        }).filter(Boolean);
        return { name: names[index] || '线路 ' + (index + 1), episodes,
            quality: resourceQuality({ vod_name: names[index], vod_remarks: episodes.map(episode => episode.name).join(' ') }).rank,
            direct: episodes.filter(episode => /\.(m3u8|mp4)(?:[?#]|$)/i.test(episode.url)).length };
    }).filter(group => group.episodes.length).sort((a, b) =>
        Number(b.quality >= 0) - Number(a.quality >= 0) || Number(!!b.direct) - Number(!!a.direct) || b.quality - a.quality || b.direct - a.direct);
}


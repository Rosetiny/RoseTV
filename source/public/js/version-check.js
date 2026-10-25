window.ROSETV_BRIDGE = { url: 'http://127.0.0.1:34771', key: '__ROSETV_BRIDGE_KEY__', enabled: false, site: false };
window.ROSETV_BRIDGE.mediaURL = address => window.ROSETV_BRIDGE.url + '/public-media?u=' +
    btoa(unescape(encodeURIComponent(address))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '&_k=' + window.ROSETV_BRIDGE.key;
window.roseGoBack = () => {
    const modal = document.getElementById('modal');
    if (modal && !modal.classList.contains('hidden')) { window.closeModal(); return; }
    if (location.pathname.includes('player.html')) {
        if (document.referrer.startsWith(location.origin) && history.length > 1) history.back();
        else location.href = 'index.html';
    } else if (sessionStorage.getItem('activeTab') === 'home' && window.popRoseCatalog?.()) {
        return;
    } else if (typeof navigateToTab === 'function') {
        navigateToTab('home');
    }
};
window.bridgeReady = new Promise(resolve => {
    document.addEventListener('DOMContentLoaded', async () => {
        const bridge = window.ROSETV_BRIDGE;
        const invoke = window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke;
        async function localRequest(path) {
            if (!invoke) throw new Error('本机窗口服务不可用');
            const response = await invoke('make_http_request', { options: { url: bridge.url + path, method: 'GET', headers: { 'X-RoseTV-Key': bridge.key }, timeout_secs: 1 } });
            if (response.status !== 200) throw new Error('本机窗口服务不可用');
            return JSON.parse(response.body);
        }
        const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = bridge.url + '/assets/rosetv.css?_k=' + bridge.key; document.head.append(css);
        await new Promise(resolve => { const script = document.createElement('script'); script.src = bridge.url + '/assets/rosetv.js?_k=' + bridge.key; script.onload = script.onerror = resolve; document.head.append(script); });
        if(window.roseEmbedded){Object.assign(bridge,{enabled:parent.ROSETV_BRIDGE.enabled,site:parent.ROSETV_BRIDGE.site});resolve(bridge);window.roseMountHeader?.();return;}
        const bar = document.createElement('div'); bar.id = 'rosetvWindowBar';
        function button(label, icon, action, size=16) {
            const element = document.createElement('button'); element.type = 'button'; element.title = label; element.setAttribute('aria-label',label);
            element.append(window.roseIcon(icon,size)); element.onclick = action; return element;
        }
        const back = button('返回', 'back', window.roseGoBack,18); back.className = 'rose-back'; back.append(document.createTextNode('返回')); bar.append(back);
        const home = button('返回 RoseTV 首页', 'film', () => window.roseGoHome()); home.append(document.createTextNode('RoseTV')); bar.append(home);
        const name = document.createElement('span'); name.className = 'rose-drag';
        name.onpointerdown = event => { if (event.button === 0) localRequest('/window/drag').catch(() => {}); };
        name.ondblclick = () => localRequest('/window/maximize').then(result => updateMaximize(result.maximized)).catch(() => {}); bar.append(name);
        let maximize;
        const updateMaximize = state => { if (maximize) maximize.replaceChildren(window.roseIcon(state ? 'restore' : 'maximize',16)); };
        for (const [label, action] of [['最小化','minimize'],['最大化 / 还原','maximize'],['关闭','close']]) {
            const control = button(label, action, () => localRequest('/window/' + action).then(result => updateMaximize(result.maximized)).catch(() => { name.textContent = '请从桌面图标启动 RoseTV'; }));
            if (action === 'maximize') maximize = control;
            bar.append(control);
        }
        document.body.prepend(bar); document.body.style.paddingTop = '56px';window.roseMountHeader?.();
        const oldBack = document.getElementById('goBack');
        if (oldBack) oldBack.onclick = event => { event.preventDefault(); window.roseGoBack(); };
        window.addEventListener('keydown', event => { if(event.altKey && event.key === 'ArrowLeft') { event.preventDefault();event.stopImmediatePropagation();window.roseGoBack(); } }, true);
        window.refreshRoseIcons();
        try {
            const health = await localRequest('/health'); bridge.enabled = health.ok; bridge.site = health.site;
            updateMaximize(health.maximized);
            if (bridge.site && typeof API_SITES !== 'undefined') {
                API_SITES.site = { name: '教父资源', api: bridge.url };
                if (typeof selectedAPIs !== 'undefined' && !localStorage.getItem('siteProviderAdded')) {
                    selectedAPIs = ['site', ...selectedAPIs.filter(id => id !== 'site')];
                    localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs)); localStorage.setItem('siteProviderAdded','true');
                }
                if (typeof initAPICheckboxes === 'function') initAPICheckboxes();
                if (typeof updateSelectedApiCount === 'function') updateSelectedApiCount();
            }
        } catch {}
        document.title = document.title.replaceAll('RoseTV', 'RoseTV');
        resolve(bridge);
        window.roseRefreshHome?.();
    }, { once:true });
});

"""Native-window checks with bounded live navigation and isolated synthetic UI data.

Requires the app's explicit --inspect mode. Never prints account data or media URLs.
"""
import json
from pathlib import Path
from ui_probe import Preview

ROOT=Path(__file__).resolve().parent.parent
preview=Preview()
results=[]
saved=preview.evaluate("JSON.stringify({local:Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])),session:Object.fromEntries(Object.keys(sessionStorage).map(k=>[k,sessionStorage.getItem(k)]))})")

def check(name,expression):
    value=preview.evaluate(expression)
    assert value.get('ok'),(name,value)
    results.append({'feature':name,**value})
    print(json.dumps({'feature':name,**value},ensure_ascii=True),flush=True)

try:
    preview.evaluate("""(()=>{
        roseStopBrowse();apiCache.clear();apiCacheBytes=0;
        window.__fluencyTransport=window.roseExecuteApiRequest;window.__fluencyFixtureCalls=[];
        window.roseExecuteApiRequest=(address,options={})=>{
            const u=new URL(address),q=u.searchParams;
            if(!['/library','/suggest'].includes(u.pathname)&&!q.has('wd'))return __fluencyTransport(address,options);
            const row={path:u.pathname,kind:q.get('kind'),page:q.get('page'),genre:q.get('genre'),lang:q.get('lang'),cancelled:false};__fluencyFixtureCalls.push(row);
            return new Promise((resolve,reject)=>{
                const cancel=()=>{clearTimeout(timer);row.cancelled=true;reject(Object.assign(new Error('cancelled'),{name:'AbortError'}));};
                const timer=setTimeout(()=>{options.signal?.removeEventListener('abort',cancel);
                    if(u.pathname==='/suggest'){resolve({list:[{title:'生化危机',year:'2002'}]});return;}
                    resolve({list:Array.from({length:16},(_,i)=>({vod_id:String(900000000+Number(q.get('page')||1)*100+i),vod_douban_id:String(900000000+Number(q.get('page')||1)*100+i),vod_name:'测试影片 '+(q.get('kind')||'search')+' '+(q.get('page')||1)+' '+i,vod_year:'2000',vod_area:'中国大陆',vod_class:'剧情 / 动作',source_code:'metadata',vod_pic:''})),pages:8,hasMore:Number(q.get('page')||1)<8,provider:'isolated fixture'});
                },window.__fluencyFixtureDelay||8);
                if(options.signal?.aborted)cancel();else options.signal?.addEventListener('abort',cancel,{once:true});
            });
        };return true;
    })()""")
    for kind in ('mv','tv','ac','variety','doc'):
        check('category_'+kind,"""(async()=>{const t=performance.now(),n=__fluencyFixtureCalls.length;roseNavigate('home','KIND');while(isLoadingHomePageItems)await new Promise(r=>setTimeout(r,10));const cards=[...document.querySelectorAll('.rose-poster-card')],cover=cards[0]?.querySelector('.rose-cover')?.getBoundingClientRect();return{ok:homeView.kind==='KIND'&&cards.length===16&&__fluencyFixtureCalls.length-n===1&&cover.height>150,ms:performance.now()-t,requests:__fluencyFixtureCalls.length-n,posterHeight:cover?.height};})()""".replace('KIND',kind))
    check('direct_page_7',"""(async()=>{await showRoseCatalog('mv',1);const n=__fluencyFixtureCalls.length;document.querySelector('.rose-pagination [aria-label="第 7 页"]').click();while(isLoadingHomePageItems)await new Promise(r=>setTimeout(r,10));const form=document.querySelector('.rose-pagination form');form.querySelector('input').value='3';form.requestSubmit();while(isLoadingHomePageItems)await new Promise(r=>setTimeout(r,10));return{ok:homeView.page===3&&__fluencyFixtureCalls.length-n===2,requests:__fluencyFixtureCalls.slice(n).map(r=>r.page)};})()""")
    check('all_filter_controls',"""(async()=>{const checks=[];for(const [key,value]of [['genre','喜剧'],['year','2000'],['region','美国'],['lang','英语']]){const labels={genre:'类型',year:'年代',region:'地区',lang:'语言'},row=[...document.querySelectorAll('.rose-filter-row')].find(r=>r.querySelector('.rose-filter-label').textContent===labels[key]);[...row.querySelectorAll('button')].find(b=>b.textContent===value).click();while(isLoadingHomePageItems)await new Promise(r=>setTimeout(r,10));checks.push(roseFilters.mv[key]===value);}for(const [label,value,key]of [['评分','8','rating'],['源标注画质','clear','quality'],['状态','finished','status']]){const input=document.querySelector('select[aria-label="'+label+'"]');input.value=value;input.dispatchEvent(new Event('change'));while(isLoadingHomePageItems)await new Promise(r=>setTimeout(r,10));checks.push(roseFilters.mv[key]===value);}const mode=document.querySelector('.rose-genre-mode');mode.value='all';mode.dispatchEvent(new Event('change'));while(isLoadingHomePageItems)await new Promise(r=>setTimeout(r,10));checks.push(roseFilters.mv.genreMode==='all');[...document.querySelectorAll('.rose-filter-tools button')].find(b=>b.textContent==='重置筛选').click();while(isLoadingHomePageItems)await new Promise(r=>setTimeout(r,10));return{ok:checks.every(Boolean)&&Object.keys(roseFilters.mv).length===0,checks:checks.length+1};})()""")
    check('rapid_last_click_only',"""(async()=>{const n=__fluencyFixtureCalls.length;for(const kind of ['tv','ac','doc','variety','tv']){roseNavigate('home',kind);await new Promise(r=>setTimeout(r,15));}while(isLoadingHomePageItems)await new Promise(r=>setTimeout(r,10));return{ok:homeView.kind==='tv'&&__fluencyFixtureCalls.length-n===1,requests:__fluencyFixtureCalls.length-n};})()""")
    check('leave_cancels_inflight',"""(async()=>{__fluencyFixtureDelay=500;const n=__fluencyFixtureCalls.length;showRoseCatalog('doc',3);await new Promise(r=>setTimeout(r,220));document.querySelector('[aria-label="设置"]').click();await new Promise(r=>setTimeout(r,20));__fluencyFixtureDelay=8;return{ok:__fluencyFixtureCalls.slice(n).some(r=>r.cancelled)&&document.querySelector('[aria-label="设置"]').getAttribute('aria-pressed')==='true'&&![...document.querySelectorAll('.rose-nav-item')].some(b=>b.classList.contains('active')),requests:__fluencyFixtureCalls.slice(n).length,cancelled:__fluencyFixtureCalls.slice(n).filter(r=>r.cancelled).length};})()""")
    check('poster_favorite',"""(async()=>{await showRoseCatalog('mv',1);const button=document.querySelector('.rose-card-favorite'),n=__fluencyFixtureCalls.length;button.click();const saved=button.getAttribute('aria-pressed')==='true';button.click();return{ok:saved&&button.getAttribute('aria-pressed')==='false'&&__fluencyFixtureCalls.length===n&&rosePlayerTabs.length===0,extraRequests:__fluencyFixtureCalls.length-n};})()""")
    check('appearance_and_settings',"""(()=>{roseNavigate('settings');document.querySelector('[data-section="appearance"]').click();const choices=[...document.querySelectorAll('.rose-theme-choice')];const states=[];for(const button of choices){button.click();states.push(button.getAttribute('aria-pressed')==='true');}const accent=document.querySelector('.rose-accent-colors select');accent.value='#278866';accent.dispatchEvent(new Event('change'));const changed=localStorage.getItem('roseAccent')==='#278866';document.querySelector('.rose-appearance-head button').click();for(const key of ['sources','playback','appearance'])document.querySelector('[data-section="'+key+'"]').click();return{ok:states.every(Boolean)&&changed&&localStorage.getItem('roseTheme')==='light'&&localStorage.getItem('roseAccent')==='#3975e5',states:states.length};})()""")
    check('storage_totals',"""(async()=>{document.querySelector('[data-section="storage"]').click();await roseStorage();const data=await roseLocalRequest('/storage');return{ok:data.totalDiskBytes>0&&document.querySelector('#roseStorageStats').textContent.includes('磁盘总占用'),totalMiB:Math.round(data.totalDiskBytes/1048576*100)/100,metadataMiB:Math.round(data.savedMetadataBytes/1048576*100)/100};})()""")
    check('source_selection_sync',"""(()=>{document.querySelector('[data-section="sources"]').click();const checkbox=document.querySelector('#normaldiv input[data-api]'),old=checkbox.checked;checkbox.click();const changed=JSON.parse(localStorage.getItem('selectedAPIs')).includes(checkbox.dataset.api)===checkbox.checked;checkbox.click();return{ok:changed&&checkbox.checked===old&&localStorage.getItem('rosePreferredSource')==='auto',count:JSON.parse(localStorage.getItem('selectedAPIs')).length};})()""")
    check('suggestions_and_ime',"""(async()=>{const input=document.querySelector('#roseBrowseNav form input');input.focus();input.value='生化';input.dispatchEvent(new Event('input'));await new Promise(r=>setTimeout(r,850));const shown=input.getAttribute('aria-expanded')==='true'&&document.querySelector('.rose-suggestion')?.textContent.includes('生化危机');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));const n=__fluencyFixtureCalls.length;input.dispatchEvent(new CompositionEvent('compositionstart'));input.value='输入中';input.dispatchEvent(new Event('input'));await new Promise(r=>setTimeout(r,850));input.dispatchEvent(new CompositionEvent('compositionend'));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return{ok:shown&&__fluencyFixtureCalls.length===n,imeRequests:__fluencyFixtureCalls.length-n};})()""")
    check('history_and_home',"""(async()=>{const n=__fluencyFixtureCalls.length;roseNavigate('history');const localOnly=__fluencyFixtureCalls.length===n;delete window.roseHomeRows;roseGoHome();while(isLoadingHomePageItems)await new Promise(r=>setTimeout(r,10));return{ok:localOnly&&homeView.kind==='home'&&__fluencyFixtureCalls.slice(n).length===1&&document.querySelectorAll('.rose-load-section').length===4,homeRequests:__fluencyFixtureCalls.length-n};})()""")
    check('rapid_200_cross_filter_clicks', """(async()=>{
        roseFilters.mv={};await showRoseCatalog('mv',1);
        const n=__fluencyFixtureCalls.length,labels=['类型','年代','地区','语言'];
        for(let i=0;i<200;i++){
            const row=[...document.querySelectorAll('.rose-filter-row')].find(r=>r.querySelector('.rose-filter-label').textContent===labels[i%4]);
            const buttons=[...row.querySelectorAll('button')].filter(b=>!b.disabled&&b.textContent!=='展开'&&b.textContent!=='收起'&&!b.classList.contains('selected'));
            buttons[(i*7)%buttons.length].click();await new Promise(r=>setTimeout(r,5));
        }
        while(isLoadingHomePageItems)await new Promise(r=>setTimeout(r,10));
        const calls=__fluencyFixtureCalls.slice(n);
        return{ok:homeView.kind==='mv'&&calls.length===1&&document.querySelectorAll('.rose-poster-card').length===16,clicks:200,requests:calls.length,realUpstreamRequests:0};
    })()""")
finally:
    preview.evaluate("""(()=>{roseStopBrowse();roseFlushMetadata();window.roseExecuteApiRequest=window.__fluencyTransport;const data=JSON.parse(SAVED);for(const [storage,rows]of [[localStorage,data.local],[sessionStorage,data.session]]){for(const key of Object.keys(storage))if(!(key in rows))storage.removeItem(key);for(const [key,value]of Object.entries(rows))storage.setItem(key,value);}roseMetadataCache=undefined;return true;})()""".replace('SAVED',json.dumps(saved)))
    (ROOT/'build/fluency-ui-checks.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    preview.call('Page.reload',{'ignoreCache':False})

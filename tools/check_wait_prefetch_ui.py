"""Native UI pacing/prefetch checks; all catalogue HTTP responses are local fixtures."""
import json
from pathlib import Path
from ui_probe import Preview

root=Path(__file__).resolve().parent.parent
p=Preview();results=[]
saved=p.evaluate("JSON.stringify({local:Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])),session:Object.fromEntries(Object.keys(sessionStorage).map(k=>[k,sessionStorage.getItem(k)]))})")
def check(name,expression):
    result=p.evaluate(expression);assert result.get('ok'),(name,result)
    results.append({'feature':name,**result});print(json.dumps(results[-1]),flush=True)
try:
    p.evaluate("""(()=>{
        roseStopBrowse();window.__waitFetch=window.fetch;window.__waitCalls=[];window.__waitBudget='';
        apiCache.clear();apiCacheBytes=0;delete window.roseHomeRows;
        window.fetch=(address,options={})=>{
            const u=new URL(address);if(u.pathname!=='/library')return __waitFetch(address,options);
            const q=u.searchParams,record={kind:q.get('kind'),page:Number(q.get('page')),genre:q.get('genre'),prefetch:q.has('prefetch'),cancelled:false};__waitCalls.push(record);
            return new Promise((resolve,reject)=>{
                const abort=()=>{clearTimeout(timer);record.cancelled=true;reject(Object.assign(new Error('cancelled'),{name:'AbortError'}));};
                const timer=setTimeout(()=>{options.signal?.removeEventListener('abort',abort);
                    if(__waitBudget&&record.genre===__waitBudget){window.__waitBudget='';resolve(new Response(JSON.stringify({error:'local pacing',code:'local_budget',retryAfterSeconds:1}),{status:429}));return;}
                    const list=Array.from({length:16},(_,i)=>({vod_id:String(800000000+record.page*100+i),vod_douban_id:String(800000000+record.page*100+i),vod_name:'Fixture '+record.kind+' '+record.page+' '+i,vod_year:'2000',vod_area:'美国',vod_class:'剧情 / 喜剧',source_code:'metadata',vod_pic:''}));
                    resolve(new Response(JSON.stringify({list,page:record.page,pages:12,hasMore:record.page<12,provider:'isolated fixture'})));
                },15);
                if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});
            });
        };roseFilters.mv={};roseNavigate('home','mv');return true;
    })()""")
    check('local_budget_keeps_cards_and_resumes',"""(async()=>{
        while(isLoadingHomePageItems)await new Promise(r=>setTimeout(r,10));
        __waitBudget='儿童';roseFilters.mv={genre:'儿童'};const loading=showRoseCatalog('mv',1);
        await new Promise(r=>setTimeout(r,230));const status=document.querySelector('.rose-library-status').textContent;
        const retained=document.querySelectorAll('.rose-poster-card').length===16;
        const enabled=[...document.querySelectorAll('.rose-filter-row button')].find(b=>b.textContent==='喜剧')?.disabled===false;
        await loading;const calls=__waitCalls.filter(r=>r.genre==='儿童'&&!r.prefetch);
        return{ok:retained&&enabled&&status.includes('自动继续')&&status.includes('上次')&&calls.length===2&&homeView.filterKey.includes('儿童'),retainedCards:retained,filtersEnabled:enabled,attempts:calls.length,realUpstreamRequests:0};
    })()""")
    check('changing_filters_cancels_wait',"""(async()=>{
        __waitBudget='动作';roseFilters.mv={genre:'动作'};const old=showRoseCatalog('mv',1);await new Promise(r=>setTimeout(r,230));
        roseFilters.mv={genre:'战争'};await showRoseCatalog('mv',1);await old;await new Promise(r=>setTimeout(r,1200));
        const attempts=__waitCalls.filter(r=>r.genre==='动作'&&!r.prefetch).length;
        return{ok:attempts===1&&homeView.filterKey.includes('战争'),oldAttempts:attempts,realUpstreamRequests:0};
    })()""")
    check('page_8_preloads_9_and_10_and_click_uses_cache',"""(async()=>{
        roseFilters.mv={genre:'家庭'};const n=__waitCalls.length;await showRoseCatalog('mv',8);
        await new Promise(r=>setTimeout(r,400));const rows=__waitCalls.slice(n),background=rows.filter(r=>r.prefetch).map(r=>r.page);
        const before=__waitCalls.length,t=performance.now();await showRoseCatalog('mv',9);const ms=performance.now()-t;
        const immediateCalls=__waitCalls.length-before;await showRoseCatalog('mv',10);roseStopBrowse();
        return{ok:background.join(',')==='9,10'&&immediateCalls===0&&homeView.page===10,backgroundPages:background,page9Ms:ms,page9Requests:immediateCalls,realUpstreamRequests:0};
    })()""")
    check('visible_home_sections_load_without_click',"""(async()=>{
        delete window.roseHomeRows;const n=__waitCalls.length;scrollTo(0,0);await roseHome(false);
        const target=[...document.querySelectorAll('.rose-section')].find(row=>row.querySelector('h2')?.textContent==='近期热门纪录片');target.scrollIntoView();
        const end=performance.now()+2500;while(!window.roseHomeRows.has('doc')&&performance.now()<end)await new Promise(r=>setTimeout(r,20));
        const visible=window.roseHomeRows.has('doc'),calls=__waitCalls.slice(n);roseStopBrowse();
        return{ok:visible&&target.querySelectorAll('.rose-poster-card').length===16,docLoaded:visible,loadedKinds:[...new Set(calls.map(r=>r.kind))],realUpstreamRequests:0};
    })()""")
finally:
    p.evaluate("""(()=>{roseStopBrowse();roseFlushMetadata();window.fetch=window.__waitFetch;apiCache.clear();apiCacheBytes=0;const data=JSON.parse(SAVED);for(const[storage,rows]of [[localStorage,data.local],[sessionStorage,data.session]]){for(const key of Object.keys(storage))if(!(key in rows))storage.removeItem(key);for(const[key,value]of Object.entries(rows))storage.setItem(key,value);}roseMetadataCache=undefined;return true;})()""".replace('SAVED',json.dumps(saved)))
    (root/'build/wait-prefetch-ui-checks.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    p.call('Page.reload',{'ignoreCache':False})

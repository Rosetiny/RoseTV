# -*- coding: utf-8 -*-
"""Native image queue/cache checks against a local delayed image server."""
import base64
import json
import threading
import time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from ui_probe import Preview

root=Path(__file__).resolve().parent.parent
png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0S0AAAAASUVORK5CYII=')
requests=[]
class Images(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        requests.append(self.path)
        time.sleep(.35 if '/1/' in self.path else .015)
        self.send_response(200);self.send_header('Content-Type','image/png');self.send_header('Content-Length',str(len(png)))
        self.send_header('Access-Control-Allow-Origin','*');self.send_header('Cache-Control','public,max-age=3600');self.end_headers()
        try:self.wfile.write(png)
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass

server=ThreadingHTTPServer(('127.0.0.1',0),Images);server.daemon_threads=True
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
p=Preview();saved=p.evaluate("JSON.stringify({local:Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])),session:Object.fromEntries(Object.keys(sessionStorage).map(k=>[k,sessionStorage.getItem(k)]))})")
try:
    p.evaluate("""(()=>{roseStopBrowse();window.__posterTransport=window.roseExecuteApiRequest;window.roseExecuteApiRequest=async(address,options)=>{
        const u=new URL(address);if(u.pathname!='/library')return __posterTransport(address,options);const page=Number(u.searchParams.get('page'));
        return {page,pages:10,hasMore:page<10,list:Array.from({length:16},(_,i)=>({vod_id:String(90000000+page*100+i),vod_name:'Poster '+page+' '+i,vod_year:'2000',vod_area:'美国',vod_class:'剧情',source_code:'metadata',vod_pic:ORIGIN+'/image/'+page+'/'+i+'.png'}))};};roseFilters.mv={};return true;})()""".replace('ORIGIN',json.dumps('http://127.0.0.1:'+str(server.server_port))))
    result=p.evaluate("""(async()=>{await showRoseCatalog('mv',1);clearTimeout(rosePrefetchTimer);await new Promise(r=>setTimeout(r,50));const t=performance.now();await showRoseCatalog('mv',2);clearTimeout(rosePrefetchTimer);scrollTo(0,document.querySelector('.rose-grid').offsetTop-65);
        const end=t+3000;let images;do{await new Promise(r=>setTimeout(r,20));images=[...document.querySelectorAll('.rose-poster img')];}while(images.filter(v=>v.complete&&v.naturalWidth).length<16&&performance.now()<end);
        return{loaded:images.filter(v=>v.complete&&v.naturalWidth).length,total:images.length,page:homeView.page,elapsedMs:Math.round(performance.now()-t),blobURLs:roseImageURLs.size};})()""")
    result['oldRequests']=sum('/1/' in address for address in requests)
    before=len(requests)
    cached=p.evaluate("""(async()=>{const t=performance.now();await showRoseCatalog('mv',2);clearTimeout(rosePrefetchTimer);const end=t+2000;while([...document.querySelectorAll('.rose-poster img')].filter(v=>v.complete&&v.naturalWidth).length<16&&performance.now()<end)await new Promise(r=>setTimeout(r,20));return{loaded:[...document.querySelectorAll('.rose-poster img')].filter(v=>v.complete&&v.naturalWidth).length,elapsedMs:Math.round(performance.now()-t)}})()""")
    cached['extraDownloads']=len(requests)-before
    result['cachedRevisit']=cached;result['realUpstreamRequests']=0
    (root/'build/poster-native-local-checks.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result));assert result['loaded']==16 and result['oldRequests']<=4 and result['elapsedMs']<2000
    assert cached['loaded']==16 and cached['extraDownloads']==0
finally:
    p.evaluate("""(()=>{roseStopBrowse();roseFlushMetadata();window.roseExecuteApiRequest=window.__posterTransport;const data=JSON.parse(SAVED);for(const[storage,rows]of[[localStorage,data.local],[sessionStorage,data.session]]){for(const key of Object.keys(storage))if(!(key in rows))storage.removeItem(key);for(const[key,value]of Object.entries(rows))storage.setItem(key,value);}roseMetadataCache=undefined;return true;})()""".replace('SAVED',json.dumps(saved)))
    p.call('Page.reload',{'ignoreCache':False});p.socket.close();server.shutdown();server.server_close();thread.join()

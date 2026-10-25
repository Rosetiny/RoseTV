# -*- coding: utf-8 -*-
"""Explicit, sequential public-source checks using the app's cached five samples."""
import argparse
import json
import time
from pathlib import Path
from ui_probe import Preview

parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('sources',nargs='+');args=parser.parse_args()
p=Preview();root=Path(__file__).resolve().parent.parent;results={}
samples=p.evaluate("roseSourceSamples(new AbortController().signal)")
assert samples and len(samples)==5,'Five cached sample titles required; no automatic metadata-site requests'
try:
    p.evaluate("(async()=>{roseStopBrowse();await roseEnsureAPI();if(typeof Hls==='undefined')await new Promise((r,j)=>{const s=document.createElement('script');s.src='libs/hls.min.js';s.onload=r;s.onerror=j;document.head.append(s)});return true})()")
    for identifier in args.sources:
        assert identifier!='site' and p.evaluate('!!API_SITES['+json.dumps(identifier)+']'),'Only a registered public source may be tested'
        checks=[]
        for sample in samples:
            expression="""(async()=>{const target=TARGET,t=Date.now(),check={kind:target.kind,label:target.label,title:target.item.vod_name,time:Date.now(),apiAvailable:false,playable:false,score:0};try{const video=await roseFindVideo(ID,target.item.vod_name,target.item.vod_year,target.item,data=>check.apiAvailable=Array.isArray(data.list),new AbortController().signal);if(!video)throw new Error('未找到同片、同年份与季数的样片');const resolved=await roseVideoGroups(video);check.queryMs=Date.now()-t;const episode=resolved.groups[0].episodes.find(row=>!/预告|花絮|先导|纯享|加更|特辑/i.test(row.name))||resolved.groups[0].episodes[0];const decoded=await roseProbeResolution(episode.url,new AbortController().signal,8000);if(!decoded)throw new Error('8 秒内未取得解码首帧');Object.assign(check,{playable:true,width:decoded.width,height:decoded.height,startMs:decoded.elapsedMs,score:roseSourceScore(decoded,check.queryMs),message:'首帧解码通过'})}catch(error){check.message=error.message}return check})()""".replace('TARGET',json.dumps(sample)).replace('ID',json.dumps(identifier))
            check=p.evaluate(expression);checks.append(check);print(json.dumps({'source':identifier,**check},ensure_ascii=True),flush=True);time.sleep(1)
        passed=[row for row in checks if row['playable']];minimum=min(passed,key=lambda row:row['width']*row['height']) if passed else {}
        results[identifier]={'testVersion':2,'time':int(time.time()*1000),'samples':checks,'passed':len(passed),'apiAvailable':any(row['apiAvailable'] for row in checks),'playable':bool(passed),'score':round(sum(row['score'] for row in checks)/5),'width':minimum.get('width'),'height':minimum.get('height'),'startMs':round(sum(row['startMs'] for row in passed)/len(passed)) if passed else 0,'message':'\n'.join(row['label']+'：'+row['title']+' · '+row['message'] for row in checks)}
    p.evaluate("(()=>{const results=JSON.parse(localStorage.getItem('roseSourceTests')||'{}');Object.assign(results,RESULTS);localStorage.setItem('roseSourceTests',JSON.stringify(results));roseCompactSources();return true})()".replace('RESULTS',json.dumps(results)))
    (root/'build/new-source-five-category-checks.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
finally:p.socket.close()

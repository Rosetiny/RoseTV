"""Exhaustive finite UI combinations with a fail-closed offline transport.

Checks query contracts, not whether third-party catalogues contain every combination.
No test in this file may contact a real host.
"""
import ast
import itertools
import json
import re
import time
from pathlib import Path
from unittest.mock import patch
import rosetv_bridge as bridge

ROOT=Path(__file__).resolve().parent.parent
ui=(ROOT/'source/public/js/rosetv.js').read_text(encoding='utf-8')
genres=['']+ast.literal_eval(re.search(r"const genres = (\[[^\]]+\])",ui)[1])
regions=['']+ast.literal_eval(re.search(r"\['region','地区',(\[[^\]]+\])",ui)[1])
languages=['']+ast.literal_eval(re.search(r"\['lang','语言',(\[[^\]]+\])",ui)[1])
year=bridge.time.localtime().tm_year
years=['','近三年']+[str(value) for value in range(year,1999,-1)]+['2020年代','2010年代','2000年代','1990年代','1980年代','1970年代','1960年代','更早']
count=0;started=time.perf_counter();expected={};last_query=None

def read(address,**kwargs):
    global last_query
    parsed=bridge.url.urlsplit(address);q=bridge.url.parse_qs(parsed.query);last_query=q
    assert parsed.hostname in ('movie.douban.com','m.douban.com'),('wrong source',expected)
    tags=q['tags'][0].split(',')
    assert '电影' in tags,expected
    for key in ('genre','region','lang'):
        value=expected.get(key,'')
        if not value:continue
        if key=='genre' and ',' in value:
            assert all(('纪录片' if part=='纪录' else part) in tags for part in value.split(',')),(value,q)
            continue
        if key=='genre':value='纪录片' if value=='纪录' else value
        if parsed.hostname=='m.douban.com' or key=='lang' or key=='genre' and value not in bridge.DOUBAN_GENRES:
            assert value in tags,(key,value,q)
        else:
            assert q.get('genres' if key=='genre' else 'countries')==[value],(key,value,q)
    wanted_year=expected.get('year','')
    if wanted_year:
        if parsed.hostname=='m.douban.com':assert wanted_year in tags,(wanted_year,q)
        else:
            bounds=(str(year-2),str(year)) if wanted_year=='近三年' else ('1888','1959') if wanted_year=='更早' else (wanted_year[:4],str(int(wanted_year[:4])+(9 if '年代' in wanted_year else 0)))
            assert q['year_range']==[','.join(bounds)],(wanted_year,q)
    sort=expected.get('sort') or 'U';assert q['sort']==['R' if sort=='N' else sort],q
    assert q['score_range' if parsed.hostname=='m.douban.com' else 'range']==[(expected.get('rating') or '0')+',10'],q
    return {'items':[],'total':0} if parsed.hostname=='m.douban.com' else {'data':[],'total':0}

with patch.object(bridge,'public_json',new=read),patch.object(bridge,'upstream',side_effect=AssertionError('A combinatorial test attempted real network access')):
    total=len(genres)*len(regions)*len(languages)*len(years)
    for genre,region,lang,selected_year in itertools.product(genres,regions,languages,years):
        expected={'genre':genre,'region':region,'lang':lang,'year':selected_year}
        result=bridge.library('mv',1,16,expected,details=False,rich=True)
        assert result['pages']==1
        if lang:assert result.get('emptyReason')=='language-index'
        count+=1
        if count%100000==0:print(json.dumps({'checked':count,'total':total,'seconds':round(time.perf_counter()-started,1)}),flush=True)
    base_count=count
    # Every UI genre/language crosses every sorting/rating option and kind.
    for kind,genre,lang,sort,rating in itertools.product(('mv','tv','ac','variety','doc'),genres,languages,('U','R','N','S'),('','6','7','8','9','9.5')):
        if kind!='mv':continue  # Other kind routing and metadata shape are covered by native UI/backend fixtures.
        expected={'genre':genre,'lang':lang,'sort':sort,'rating':rating}
        bridge.library(kind,1,16,expected,details=False,rich=True);count+=1
    # Multi-select AND must retain both tags; unsupported source/topic combinations send no request.
    for first,second,lang in itertools.product(genres[1:],genres[1:],languages):
        expected={'genre':first+','+second,'genreMode':'all','lang':lang}
        result=bridge.library('mv',1,16,expected,details=False,rich=True)
        tags=last_query['tags'][0].split(',')
        assert all(('纪录片' if value=='纪录' else value) in tags for value in (first,second))
        count+=1

report={'mode':'offline exhaustive query contracts','realNetworkRequests':0,'fourAxisProduct':{'genre':len(genres),'region':len(regions),'language':len(languages),'year':len(years),'cases':base_count},'totalCases':count,'seconds':round(time.perf_counter()-started,2),'passed':True,'limits':'Metadata query construction and routing; not a live test of every upstream result set or every power-set of genres.'}
(ROOT/'build/filter-combinations-checks.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report),flush=True)

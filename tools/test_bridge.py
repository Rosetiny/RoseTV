import base64
import json
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit, parse_qs
from http.server import ThreadingHTTPServer

import requests
import rosetv_bridge as bridge

class BridgeChecks(unittest.TestCase):
    def setUp(self):
        from collections import OrderedDict
        for context in (patch.object(bridge,'PUBLIC_RECORDS',OrderedDict()),patch.object(bridge,'REQUEST_TIMES',{'douban':[],'site':[]})):
            context.start();self.addCleanup(context.stop)

    def test_session_requires_explicit_authorization(self):
        with patch.object(bridge, 'configuration', return_value={'siteSessionAuthorized':False}), patch.object(bridge.site_session,'has_session',return_value=True):
            with self.assertRaises(PermissionError):
                bridge.site_client()

    def test_json_is_parsed_not_executed(self):
        self.assertEqual(bridge.assignment('_obj.inlist=[{"t":["movie"]}];alert(1)', 'inlist'), [{'t': ['movie']}])
        with self.assertRaises(ValueError):
            bridge.assignment('_obj.inlist=process.exit()', 'inlist')

    def test_compressed_episode_names(self):
        self.assertEqual(bridge.expand_episodes(['正片', [['第', '集'], [1, 3]]]), ['正片', '第1集', '第2集', '第3集'])

    def test_media_playlist_keeps_timeline_and_keys(self):
        original = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"\n#EXT-X-DISCONTINUITY\n#EXTINF:4,\nsegment.ts\n'
        output = bridge.rewrite_playlist(original, 'https://cdn.test/a/list.m3u8')
        self.assertIn('#EXT-X-DISCONTINUITY', output)
        self.assertEqual(output.count('/media?'), 2)
        address = next(line for line in output.splitlines() if line.startswith('http'))
        encoded = parse_qs(urlsplit(address).query)['u'][0]
        self.assertEqual(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)).decode(), 'https://cdn.test/a/segment.ts')

    def test_proxy_rejects_private_addresses(self):
        with patch.object(bridge.socket, 'getaddrinfo', return_value=[(0, 0, 0, '', ('127.0.0.1', 80))]):
            with self.assertRaises(ValueError):
                bridge.safe_url('http://private.test/')
        with patch.object(bridge.socket, 'getaddrinfo', return_value=[(0, 0, 0, '', ('8.8.8.8', 443))]):
            self.assertEqual(bridge.safe_url('https://public.test/'), 'https://public.test/')
        for address in ['file:///c:/secret', 'http://user:password@public.test/']:
            with self.assertRaises(ValueError):
                bridge.safe_url(address)

    def test_public_playlists_do_not_require_site_session(self):
        text = '#EXTM3U\n#EXT-X-KEY:URI="key.bin"\nsegment.ts\n'
        with patch.object(bridge, 'site_client', side_effect=AssertionError('Public media must not access account cookies')):
            output = bridge.rewrite_playlist(text, 'https://cdn.test/video/list.m3u8', public=True)
            self.assertEqual(output.count('/public-media?'), 2)
            self.assertNotIn('/media?', output)

    def test_site_catalog_filters_trailers_and_keeps_country_ids_out_of_ui(self):
        fixture = {'i': ['one', 'two'], 't': ['Movie', 'Trailer'], 'g': ['', '预告'],
            'a': [[2026, 67], [2026, 1]], 'd': [8, 7]}
        with patch.object(bridge, 'site_json', return_value=fixture):
            data = bridge.site_catalog('mv', 2)
        self.assertEqual(len(data['list']), 1)
        self.assertEqual(data['list'][0]['vod_area'], '')
        self.assertEqual(data['page'], 2)
        with self.assertRaises(ValueError):
            bridge.site_catalog('../private', 1)

    def test_site_details_prefers_verified_direct_lines(self):
        fixture = {'playlist': [
            {'i': 'bf', 't': '暴风线路', 'list': ['高清']},
            {'i': 'ff', 't': '非凡线路', 'list': ['高清']},
            {'i': 'nn', 't': '牛牛线路', 'list': ['高清']}]}
        with patch.object(bridge, 'site_json', return_value=fixture):
            data = bridge.site_details('mv_test')
        self.assertTrue(data['list'][0]['vod_play_from'].startswith('非凡'))

    def test_responsive_catalog_cursor_fills_rows_without_skipping(self):
        def page(path):
            number = int(path.rsplit('/', 1)[1])
            ids = [str((number - 1) * 12 + i) for i in range(12)]
            return {'i': ids, 't': ids, 'g': ['预告' if item in ('3', '8', '20') else '' for item in ids]}
        with patch.object(bridge, 'site_json', side_effect=page):
            first = bridge.site_catalog('mv', limit=16, cursor=0)
            second = bridge.site_catalog('mv', limit=16, cursor=first['nextCursor'])
        self.assertEqual(len(first['list']), 16)
        self.assertEqual(len(second['list']), 16)
        ids = [int(item['vod_id'].split('_')[1]) for item in first['list'] + second['list']]
        self.assertEqual(ids, [i for i in range(35) if i not in (3, 8, 20)])
        with self.assertRaises(ValueError):
            bridge.site_catalog('mv', limit=1000)

    def test_site_media_falls_back_after_direct_connection_timeout(self):
        from collections import OrderedDict
        from unittest.mock import Mock
        client = Mock()
        client.get.side_effect = requests.ConnectTimeout()
        response = Mock(status_code=200)
        with patch.object(bridge, 'safe_url', side_effect=lambda value: value), patch.object(bridge, 'MEDIA_ROUTES', OrderedDict()), patch.object(bridge.PROXY_HTTP, 'get', return_value=response) as proxy:
            self.assertIs(bridge.upstream('https://cdn.test/a.m3u8', client, video=True), response)
            self.assertEqual(proxy.call_count, 1)
            self.assertIn('cdn.test', bridge.MEDIA_ROUTES)

    def test_public_metadata_cache_preserves_bytes_across_pages(self):
        from collections import OrderedDict
        calls = []
        original = '{"list":[{"vod_name":"影片"}]}'.encode('utf-8')
        def read():
            calls.append(True)
            return original, 'text/html; charset=utf-8'
        with patch.object(bridge, 'CACHE', OrderedDict()):
            self.assertEqual(bridge.cached('api:public', read)[0], original)
            self.assertEqual(bridge.cached('api:public', read)[0], original)
            self.assertEqual(len(calls), 1)

    def test_body_limit_stops_before_unbounded_read(self):
        chunks = iter([b'1234', b'5678', b'not consumed'])
        with self.assertRaises(ValueError): bridge.read_limited(chunks, 6)
        self.assertEqual(next(chunks), b'not consumed')

    def test_metadata_pagination_lookahead_keeps_all_items_and_detects_exact_last_page(self):
        def read(address):
            if '/recommend?' in address:return {'items':[]}
            query=parse_qs(urlsplit(address).query);start=int(query['start'][0])
            self.assertEqual(query['count'],['20'])
            return {'data':[{'id':i,'title':str(i)} for i in range(start,min(48,start+20))]}
        with patch.object(bridge, 'public_json', side_effect=read):
            for limit in (16,24):
                results=[bridge.library('mv',page,limit,{}) for page in range(1,48//limit+1)]
                self.assertEqual([int(item['vod_id']) for data in results for item in data['list']],list(range(48)))
                self.assertTrue(results[0]['hasMore']);self.assertFalse(results[-1]['hasMore'])
                self.assertNotIn('pages',results[0])
                self.assertEqual(results[-1]['pages'],48//limit);self.assertEqual(results[-1]['total'],48)

    def test_catalog_topic_labels_use_tags_and_preserve_other_conditions(self):
        calls=[]
        with patch.object(bridge,'catalog_metadata_batch',return_value={}),patch.object(bridge,'public_json',side_effect=lambda address:calls.append(parse_qs(urlsplit(address).query,keep_blank_values=True)) or {'data':[{'id':'1','title':'Match'}]}):
            for topic in ['谍战','公路','社会','超级英雄','魔幻','丧尸','校园','文艺','青春','推理','警匪','末日','励志','人性','美食','女性','治愈','热血','搞笑','机战','日常']:
                data=bridge.library('mv',1,16,{'genre':topic,'year':'2024','rating':'8','region':'美国','sort':'S'})
                query=calls[-1]
                self.assertIn(topic,query['tags'][0].split(','));self.assertEqual(query['genres'],[''])
                self.assertEqual(query['year_range'],['2024,2024']);self.assertEqual(query['countries'],['美国']);self.assertEqual(query['sort'],['S']);self.assertEqual(query['range'],['8,10'])
                self.assertEqual(data['list'][0]['vod_class'],'')
            for label,actual in [('剧情','剧情'),('纪录','纪录片'),('舞台艺术','舞台艺术'),('真人秀','真人秀')]:
                data=bridge.library('mv',1,16,{'genre':label})
                self.assertEqual(calls[-1]['genres'],[actual]);self.assertEqual(data['list'][0]['vod_class'],actual)

    def test_catalog_empty_first_page_has_exact_zero_total_and_one_page(self):
        with patch.object(bridge,'public_json',return_value={'data':[]}):
            empty=bridge.library('mv',1,16,{'genre':'公路','year':'1900'})
            self.assertEqual((empty['total'],empty['pages'],empty['hasMore']),(0,1,False))
            later=bridge.library('mv',100,16,{'genre':'公路'})
            self.assertNotIn('pages',later)

    def test_metadata_default_posters_are_missing_data_and_default_sort_is_popular(self):
        calls=[]
        def read(address):
            calls.append(parse_qs(urlsplit(address).query))
            return {'data':[{'id':1,'title':'Missing','cover':'https://asset.doubanio.com/cuphead/movie-static/pics/movie_default_large.png'},
                            {'id':2,'title':'Poster','cover':'https://img3.doubanio.com/view/photo/public/p123.jpg'}]}
        with patch.object(bridge,'public_json',side_effect=read):data=bridge.library('mv',1,16,{})
        self.assertEqual(data['list'][0]['vod_pic'],'')
        self.assertIn('/public-media?',data['list'][1]['vod_pic'])
        self.assertEqual(calls[0]['sort'],['U'])

    def test_metadata_uses_real_total_when_provided_and_rejects_invalid_shape(self):
        with patch.object(bridge,'public_json',return_value={'total':100,'data':[{'id':i} for i in range(20)]}):
            data=bridge.library('mv',1,16,{})
        self.assertEqual(data['total'],100);self.assertEqual(data['pages'],7)
        with patch.object(bridge,'public_json',return_value={'error':'temporarily unavailable'}):
            with self.assertRaises(ValueError):bridge.library('mv',1,16,{})

    def test_subject_metadata_includes_year_region_and_actual_genres(self):
        fixture={'subject':{'id':'1292052','release_year':'1994','region':'美国','types':['犯罪','剧情'],'actors':['A'],'directors':['B']}}
        with patch.object(bridge,'public_json',return_value=fixture):
            info=bridge.subject_info('1292052')
            self.assertEqual(info['vod_year'],'1994');self.assertEqual(info['vod_area'],'美国');self.assertEqual(info['vod_class'],'犯罪 / 剧情')
            with self.assertRaises(ValueError):bridge.subject_info('42')
        with self.assertRaises(ValueError):bridge.subject_info('../path')

    def test_batch_metadata_uses_exact_ids_and_does_not_replace_order_or_total(self):
        rows=[{'id':str(i),'title':'Film '+str(i)} for i in range(20)]
        def read(address):
            if '/new_search_subjects?' in address:return {'data':rows}
            return {'total':500,'items':[{'id':'chart_42','card_subtitle':'Fake / Fake / 恐怖'},
                {'id':'1','year':'2002','card_subtitle':'2002 / 英国 德国 / 科幻 恐怖 / Director / Actors'},
                {'id':'99','year':'1990','card_subtitle':'1990 / 美国 / 喜剧'}]}
        with patch.object(bridge,'public_json',side_effect=read):data=bridge.library('mv',1,16,{})
        self.assertEqual([item['vod_id'] for item in data['list']],[str(i) for i in range(16)])
        self.assertEqual(data['list'][1]['vod_year'],'2002');self.assertEqual(data['list'][1]['vod_area'],'英国 德国')
        self.assertEqual(data['list'][1]['vod_class'],'科幻 / 恐怖');self.assertEqual(data['list'][0]['vod_class'],'')
        self.assertNotIn('total',data)

    def test_visible_library_page_never_waits_for_uncached_batch_metadata(self):
        from collections import OrderedDict
        calls=[]
        def read(address):
            calls.append(address)
            if '/recommend?' in address:raise AssertionError('Visible list must not fetch batch metadata')
            start=int(parse_qs(urlsplit(address).query)['start'][0])
            return {'data':[{'id':str(i),'title':'Film '+str(i)} for i in range(start,start+20)]}
        with patch.object(bridge,'CACHE',OrderedDict()),patch.object(bridge,'public_json',side_effect=read):
            result=bridge.library('mv',7,16,{},details=False)
        self.assertEqual(len(calls),1)
        self.assertEqual([int(row['vod_id']) for row in result['list']],list(range(96,112)))
        self.assertTrue(result['metadataPending'])
        # A cached first block must not turn the second block into a blocking enrichment.
        def metadata(kind,query,start,cache_only=False):
            self.assertTrue(cache_only)
            return {str(i):{'vod_year':'1994','vod_area':'美国','vod_class':'剧情'} for i in range(start,start+20)}
        with patch.object(bridge,'public_json',side_effect=read),patch.object(bridge,'catalog_metadata_batch',side_effect=metadata):
            result=bridge.library('mv',7,16,{},details=False)
        self.assertFalse(result['metadataPending'])

    def test_foreground_navigation_precedes_queued_background_metadata(self):
        from concurrent.futures import ThreadPoolExecutor
        background_waiting=threading.Event();foreground_waiting=threading.Event();order=[]
        def work(name,background,ready):
            ready.set()
            with bridge.douban_turn(background):order.append(name)
        with ThreadPoolExecutor(max_workers=2) as pool:
            with bridge.douban_turn(True):
                background=pool.submit(work,'metadata',True,background_waiting)
                self.assertTrue(background_waiting.wait(1))
                foreground=pool.submit(work,'page seven',False,foreground_waiting)
                self.assertTrue(foreground_waiting.wait(1))
                # Observe the queued foreground request before releasing the current one.
                for _ in range(100):
                    with bridge.DOUBAN_CONDITION:
                        if bridge.DOUBAN_QUEUE['foreground']:break
                    threading.Event().wait(.005)
                self.assertEqual(bridge.DOUBAN_QUEUE['foreground'],1)
            foreground.result(timeout=2);background.result(timeout=2)
        self.assertEqual(order,['page seven','metadata'])

    def test_title_subject_lookup_never_uses_a_different_year_or_ambiguous_title(self):
        rows=[{'id':'1','title':'Same','year':'2025'},{'id':'2','title':'Same','year':'2026'}]
        with patch.object(bridge,'public_json',return_value=rows),patch.object(bridge,'subject_info',side_effect=lambda identifier:{'id':identifier}):
            self.assertEqual(bridge.find_subject_info('Same','2026'),{'id':'2'})
            with self.assertRaises(ValueError):bridge.find_subject_info('Same','2024')
            with self.assertRaises(ValueError):bridge.find_subject_info('Same')

    def test_search_suggestions_are_bounded_public_data(self):
        rows=[{'title':'生化危机'+str(i),'year':'2002','id':str(i)} for i in range(12)]
        with patch.object(bridge,'public_json',return_value=rows) as request,patch.object(bridge,'site_client',side_effect=AssertionError('No account requests')):
            result=bridge.search_suggestions('生化')
            self.assertEqual(len(result['list']),8)
            self.assertIn('subject_suggest',request.call_args[0][0])
            self.assertEqual(result['list'][0]['year'],'2002')
        for keyword in ['', 'x'*81]:
            with self.assertRaises(ValueError):bridge.search_suggestions(keyword)

    def test_invalid_metadata_response_never_poisons_the_six_hour_cache(self):
        address='https://movie.douban.com/j/new_search_subjects?test=1'
        response=requests.Response();response.status_code=200;response._content=b'{"error":"temporary"}';response._content_consumed=True
        with patch.object(bridge,'CACHE',{}),patch.object(bridge,'DOUBAN_TIMING',{'last':0,'blockedUntil':0}),patch.object(bridge.time,'sleep'),patch.object(bridge,'upstream',return_value=response):
            with self.assertRaises(ValueError):bridge.public_json(address)
            self.assertNotIn('catalog:'+address,bridge.CACHE)
            bridge.CACHE['catalog:'+address]=(bridge.time.monotonic(),{'error':'old failure'},10)
            response._content=b'{"data":[]}'
            self.assertEqual(bridge.public_json(address),{'data':[]})

    def test_metadata_verification_is_not_empty_and_cached_success_remains_available(self):
        address='https://movie.douban.com/j/new_search_subjects?restricted=1'
        cached_address='https://movie.douban.com/j/new_search_subjects?cached=1'
        response=requests.Response();response.status_code=200;response._content=json.dumps({'msg':'检测到有异常请求，请登录再试','r':1}).encode();response._content_consumed=True
        cache={'catalog:'+cached_address:(bridge.time.monotonic(),{'data':[{'id':'1'}]},10)}
        with patch.object(bridge,'CACHE',cache),patch.object(bridge,'DOUBAN_TIMING',{'last':0,'blockedUntil':0}),patch.object(bridge,'CONFIG_FILE'),patch.object(bridge,'CONFIG',{}),patch.object(bridge,'configuration',return_value={}),patch.object(bridge,'upstream',return_value=response) as request:
            with self.assertRaisesRegex(PermissionError,'暂停新请求'):bridge.public_json(address)
            with self.assertRaises(PermissionError):bridge.public_json(address+'different')
            with self.assertRaises(PermissionError):bridge.public_json('https://m.douban.com/rexxar/api/v2/movie/recommend?start=0')
            self.assertEqual(request.call_count,1)
            self.assertEqual(bridge.public_json(cached_address),{'data':[{'id':'1'}]})
            self.assertNotIn('catalog:'+address,cache)

    def test_saved_login_sessions_are_selected_by_exact_origin(self):
        session=bridge.site_session
        one,two=session.SITE,'https://another.example'
        with patch.object(session,'saved_sessions',return_value={one:{'cookies':[{'name':'app_auth'}]},two:{'cookies':[{'name':'other'}]}}):
            self.assertEqual(session.load_session(one)['cookies'][0]['name'],'app_auth')
            self.assertEqual(session.load_session(two)['cookies'][0]['name'],'other')
            self.assertFalse(session.has_session('https://not-saved.example'))

    def test_login_reuse_restores_only_unexpired_same_domain_auth(self):
        data={'origin':bridge.site_session.SITE,'cookies':[
            {'name':'app_auth','value':'test-auth','domain':'www.xn--wcv59z.com','path':'/','expires':bridge.time.time()+60},
            {'name':'browser_verified','value':'test-verification','domain':'www.xn--wcv59z.com','path':'/'}]}
        cookies=bridge.site_session.reusable_auth_cookies(data,bridge.site_session.SITE)
        self.assertEqual([row['name'] for row in cookies],['app_auth'])
        self.assertEqual(bridge.site_session.reusable_auth_cookies(data,'https://www.xn--kivn76b41nnhi.com'),[])
        data['cookies'][0]['expires']=bridge.time.time()-1
        self.assertEqual(bridge.site_session.reusable_auth_cookies(data,bridge.site_session.SITE),[])

    def test_excluding_early_versions_keeps_metadata_titles_and_source_titles(self):
        fixture={'data':[{'id':str(i),'title':str(i),'rate':8} for i in range(17)]}
        with patch.object(bridge,'public_json',return_value=fixture):
            normal=bridge.library('mv',1,16,{'sort':'S','rating':'8'})
            clear=bridge.library('mv',1,16,{'sort':'S','rating':'8','quality':'clear'})
        self.assertEqual(normal['list'],clear['list']);self.assertEqual(normal['hasMore'],clear['hasMore'])
        self.assertTrue(bridge.matches_catalog_filters({'vod_remarks':'未标注'}, {'quality':'clear'}))
        self.assertFalse(bridge.matches_catalog_filters({'vod_remarks':'TC抢先版'}, {'quality':'clear'}))

    def test_editable_provider_addresses_reject_credentials_paths_and_local_network(self):
        with patch.object(bridge.socket,'getaddrinfo',return_value=[(0,0,0,'',('8.8.8.8',443))]):
            self.assertEqual(bridge.provider_origin('https://教父.com/'),'https://xn--wcv59z.com')
            for value in ['http://public.test','https://user:secret@public.test','https://public.test/path','https://public.test/?key=value']:
                with self.assertRaises(ValueError):bridge.provider_origin(value)
        with patch.object(bridge.socket,'getaddrinfo',return_value=[(0,0,0,'',('127.0.0.1',443))]):
            with self.assertRaises(ValueError):bridge.provider_origin('https://local.test')

    def test_category_http_defaults_accept_empty_filter_values(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), bridge.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def read(address):
            return {'data':[{'id':i,'title':str(i)} for i in range(20)]}
        try:
            with patch.object(bridge, 'public_json', side_effect=read), requests.Session() as client:
                client.trust_env=False
                for kind in ('mv','tv','ac','variety','doc'):
                    response=client.get('http://127.0.0.1:'+str(server.server_port)+'/library',
                        params={'kind':kind,'genreMode':''},headers={'X-RoseTV-Key':bridge.KEY},timeout=3)
                    self.assertEqual(response.status_code,200,kind)
                    self.assertEqual(len(response.json()['list']),16,kind)
                    self.assertEqual(response.json()['provider'],'豆瓣影片资料',kind)
        finally:
            server.shutdown();server.server_close();thread.join()

    def test_home_handles_text_year_and_partial_provider_failure(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def raise_for_status(self):
                pass
            def iter_content(self, size):
                yield json.dumps({'list': [{'vod_id': 12, 'vod_name': 'Recent movie', 'vod_year': '2026–',
                    'vod_douban_score': 'N/A', 'vod_pic': 'https://cdn.test/poster.webp', 'vod_play_url': 'HD$https://cdn.test/a.m3u8'}]}).encode()
        def get(*args, **kwargs):
            if kwargs['params']['t'] == 29:
                raise requests.Timeout('temporary unavailable')
            return Response()
        with patch.object(bridge.HTTP, 'get', side_effect=get), patch.object(bridge, 'CACHE', {}):
            data = bridge.public_recommendations()
            self.assertEqual(len(data['groups']), 2)
            self.assertTrue(all(group['list'] for group in data['groups']))
            self.assertIn('/public-media?', data['groups'][0]['list'][0]['vod_pic'])

    def test_native_adapter_requires_local_key_and_origin(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), bridge.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = requests.Session()
        client.trust_env = False
        base = 'http://127.0.0.1:' + str(server.server_port)
        try:
            self.assertEqual(client.get(base + '/health').status_code, 401)
            response = client.get(base + '/health', headers={'X-RoseTV-Key': bridge.KEY})
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.json()['ok'])
            response = client.get(base + '/health', headers={'X-RoseTV-Key': bridge.KEY, 'Origin': 'https://untrusted.test'})
            self.assertEqual(response.status_code, 403)
        finally:
            client.close()
            server.shutdown()
            server.server_close()
            thread.join()

    def test_account_changes_require_local_key_and_trusted_origin(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),bridge.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        client=requests.Session();client.trust_env=False
        base='http://127.0.0.1:'+str(server.server_port)
        try:
            with patch.object(bridge.site_session,'start_login',return_value={'opened':True}) as login:
                self.assertEqual(client.post(base+'/account/login',timeout=3).status_code,401)
                self.assertEqual(client.post(base+'/account/login',headers={'X-RoseTV-Key':bridge.KEY,'Origin':'https://untrusted.test'},timeout=3).status_code,401)
                login.assert_not_called()
                self.assertEqual(client.post(base+'/account/login',headers={'X-RoseTV-Key':bridge.KEY,'Origin':'http://tauri.localhost'},timeout=3).status_code,200)
                login.assert_called_once()
            with patch.object(bridge.site_session,'login_status',return_value={'loginWindowOpen':False}), patch.object(bridge.site_session,'save_browser_session') as save:
                self.assertEqual(client.post(base+'/account/save',headers={'X-RoseTV-Key':bridge.KEY},timeout=3).status_code,400)
                save.assert_not_called()
        finally:
            client.close();server.shutdown();server.server_close();thread.join()

    def test_recent_hot_filters_reach_catalog_query(self):
        calls = []
        def read(address): calls.append(parse_qs(urlsplit(address).query)); return {'data': []}
        with patch.object(bridge, 'public_json', side_effect=read):
            bridge.library('variety', 1, 8, {'sort':'U', 'year':'近三年', 'genre':'真人秀', 'region':'日本'})
        self.assertEqual(calls[0]['sort'], ['U'])
        self.assertEqual(calls[0]['genres'], ['真人秀'])
        self.assertEqual(calls[0]['countries'], ['日本'])
        self.assertEqual(calls[0]['year_range'], [str(bridge.time.localtime().tm_year-2)+','+str(bridge.time.localtime().tm_year)])

    def test_rating_and_excluding_cam_use_metadata_instead_of_empty_source_scores(self):
        calls=[]
        def read(address):
            calls.append(parse_qs(urlsplit(address).query))
            return {'data':[{'id':str(i),'title':'Film '+str(i),'rate':8.5,'casts':[{'name':'Actor'}]} for i in range(16)]}
        with patch.object(bridge,'public_json',side_effect=read):
            data=bridge.library('mv',1,16,{'rating':'8','quality':'clear','genreMode':''})
        self.assertEqual(len(data['list']),16)
        self.assertEqual(calls[0]['range'],['8,10'])
        self.assertEqual(data['list'][0]['vod_actor'],'Actor')

    def test_excluding_cam_preserves_all_metadata_sort_orders(self):
        calls=[]
        def read(address):calls.append(parse_qs(urlsplit(address).query));return {'data':[]}
        with patch.object(bridge,'public_json',side_effect=read):
            for sort in ('R','U','T','N','S'):bridge.library('mv',1,16,{'quality':'clear','sort':sort})
        self.assertEqual([query['sort'][0] for query in calls],['R','U','S','R','S'])
        self.assertTrue(all('year_range' not in query for i,query in enumerate(calls) if i!=3))
        self.assertIn('year_range',calls[3])

    def test_filtered_page_continues_after_first_batch_without_skipping(self):
        calls=[]
        def read(address):
            query=parse_qs(urlsplit(address).query);calls.append(query)
            page=int(query.get('pg',['1'])[0])
            return {'total':200,'list':[{'vod_id':i,'vod_name':str(i),'vod_class':'科幻','vod_remarks':'TC' if i<70 else 'HD'} for i in range((page-1)*20,page*20)]}
        with patch.object(bridge,'public_json',side_effect=read):
            data=bridge.library('mv',1,16,{'genre':'科幻','quality':'hd'})
            self.assertEqual(data['list'],[]);self.assertEqual(data['nextCursor'],40)
            next_batch=bridge.library('mv',2,16,{'genre':'科幻','quality':'hd','cursor':str(data['nextCursor'])})
            self.assertEqual([x['vod_id'] for x in next_batch['list']],list(range(70,80)))
            data=bridge.library('mv',3,6,{'genre':'科幻','quality':'hd','cursor':str(next_batch['nextCursor'])})
        self.assertEqual([x['vod_id'] for x in data['list']],list(range(80,86)))
        self.assertEqual(data['nextCursor'],86)
        self.assertTrue(all(query['t']==['9'] for query in calls))

    def test_single_genre_uses_full_metadata_catalog_instead_of_one_source_subtype(self):
        calls=[]
        def read(address):
            calls.append(address)
            return {'data':[{'id':'1292402','title':'西西里的美丽传说','rate':'8.9'}]}
        with patch.object(bridge,'public_json',side_effect=read):
            data=bridge.library('mv',1,16,{'genre':'情色','sort':'T'})
            bridge.library('mv',1,16,{'genre':'动作','quality':'clear'})
        self.assertEqual(data['list'][0]['vod_class'],'情色')
        self.assertEqual(data['list'][0]['vod_name'],'西西里的美丽传说')
        self.assertTrue(all(urlsplit(address).hostname in ('movie.douban.com','m.douban.com') for address in calls))
        catalogs=[address for address in calls if '/new_search_subjects?' in address]
        self.assertEqual(parse_qs(urlsplit(catalogs[-1]).query)['genres'],['动作'])

    def test_cache_location_migrates_snapshot_and_only_cleans_owned_network_cache(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();old=root/'old';new=root/'new';old.mkdir();new.mkdir()
            (old/'.rosetv-cache').write_text('owned');(new/'.rosetv-cache').write_text('owned')
            (old/'Network').mkdir();(old/'Network/a').write_text('cached')
            (old/'keep.txt').write_text('retain');snapshot=old/'catalog-cache.json.gz';snapshot.write_bytes(b'public cache')
            config={'key':'test','cacheDirectory':str(old),'cacheDirectoryPending':str(new)}
            with patch.object(bridge,'CONFIG',config),patch.object(bridge,'CONFIG_FILE',root/'config.json'),patch.object(bridge,'PUBLIC_CACHE_FILE',snapshot):
                self.assertTrue(bridge.cache_location_status()['restartRequired']);bridge.activate_cache_directory()
                self.assertEqual(bridge.PUBLIC_CACHE_FILE,new/'catalog-cache.json.gz');self.assertFalse(bridge.cache_location_status()['restartRequired'])
                self.assertEqual((new/'catalog-cache.json.gz').read_bytes(),b'public cache');self.assertEqual(bridge.network_cache_path(),new/'Network')
            self.assertTrue((old/'keep.txt').exists());self.assertFalse((old/'Network').exists());self.assertFalse(snapshot.exists())

    def test_cancelled_cache_picker_keeps_current_location(self):
        from unittest.mock import Mock
        with patch.object(bridge.subprocess,'run',return_value=Mock(returncode=0,stdout=b'')):
            before=dict(bridge.CONFIG);result=bridge.choose_cache_directory()
        self.assertTrue(result['cancelled']);self.assertEqual(bridge.CONFIG,before)

    def test_cache_picker_saves_pending_directory_without_moving_live_cache(self):
        import tempfile,base64
        from pathlib import Path
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();config={'key':'test'}
            result=Mock(returncode=0,stdout=base64.b64encode(str(root).encode()))
            with patch.object(bridge,'CONFIG',config),patch.object(bridge,'CONFIG_FILE',root/'config.json'),patch.object(bridge.subprocess,'run',return_value=result):
                status=bridge.choose_cache_directory()
            self.assertTrue(status['restartRequired']);self.assertEqual(status['pending'],str(root/'RoseTV-Cache'))
            self.assertNotIn('cacheDirectory',config);self.assertTrue((root/'RoseTV-Cache/.rosetv-cache').is_file())

    def test_storage_reports_real_files_without_counting_backups_as_program(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'App').mkdir();(root/'App/app.exe').write_bytes(b'12345')
            for name,amount in [('runtime/python-runtime.zip',10),('runtime/python/python.exe',20),('vendor/base.br',4),('source/public/js/app.js',8),('RoseTV.exe',3)]:
                path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'x'*amount)
            (root/'backup').write_bytes(b'x'*100)
            profile=root/'AppData/Local/com.rosetv.app/EBWebView/Default/Cache'
            profile.mkdir(parents=True);(profile/'item').write_bytes(b'1234567')
            account=root/'account'
            for folder,amount in [('Default/Extensions/example',11),('chrome/Default/IndexedDB/example',13),('chrome/Default/Cache',17)]:
                path=account/folder;path.mkdir(parents=True);(path/'item').write_bytes(b'x'*amount)
            with patch.object(bridge, 'ROOT', root), patch.object(bridge.Path, 'home', return_value=root),patch.object(bridge,'CONFIG',{}),patch.object(bridge.site_session,'LOGIN_DATA',account):
                status=bridge.storage_status()
            self.assertEqual(status['applicationBytes'],50)
            self.assertEqual(status['profileBytes'],7)
            self.assertEqual(status['browserCacheBytes'],7)
            self.assertEqual(status['accountBrowserBytes'],41)
            self.assertEqual(status['accountBrowserExtensionBytes'],11)
            self.assertEqual(status['accountBrowserSiteStorageBytes'],13)
            self.assertEqual(status['accountBrowserCacheBytes'],17)

    def test_genre_combinations_and_quality_use_source_fields(self):
        video={'vod_class':'动作,喜剧','type_name':'动作片','vod_year':'2025','vod_area':'中国大陆','vod_lang':'汉语普通话','vod_douban_score':'8.1','vod_remarks':'1080P','vod_isend':1}
        self.assertTrue(bridge.matches_catalog_filters(video,{'genre':'动作,喜剧','genreMode':'all','quality':'1080','status':'finished'}))
        self.assertFalse(bridge.matches_catalog_filters(video,{'genre':'动作,恐怖','genreMode':'all'}))
        self.assertTrue(bridge.matches_catalog_filters(video,{'genre':'动作,恐怖','genreMode':'any'}))
        self.assertFalse(bridge.matches_catalog_filters(video,{'genre':'动作','genreMode':'exclude'}))
        self.assertFalse(bridge.matches_catalog_filters(video,{'quality':'4k'}))
        self.assertFalse(bridge.matches_catalog_filters({}, {'status':'ongoing'}))
        self.assertFalse(bridge.matches_catalog_filters({'vod_class':'剧情','vod_blurb':'一家人搬进闹鬼的老宅'}, {'genre':'恐怖,惊悚,丧尸','genreMode':'exclude'}))

    def test_filtered_cursor_does_not_skip_matching_titles(self):
        def read(address):
            query=parse_qs(urlsplit(address).query);page=int(query.get('pg',['1'])[0])
            return {'total':100,'list':[{'vod_id':i,'vod_name':str(i),'vod_class':'历史' if i%2 else '战争'} for i in range((page-1)*20,page*20)]}
        filters={'genre':'战争','genreMode':'exclude'}
        with patch.object(bridge,'public_json',side_effect=read):
            first=bridge.library('doc',1,4,filters)
            second=bridge.library('doc',2,4,{**filters,'cursor':str(first['nextCursor'])})
        self.assertEqual([row['vod_id'] for row in first['list']+second['list']],[1,3,5,7,9,11,13,15])

    def test_concurrent_cache_misses_share_one_upstream_request(self):
        from concurrent.futures import ThreadPoolExecutor
        calls=[];started=threading.Event();release=threading.Event()
        def read(): calls.append(True);started.set();release.wait(2);return {'ok':True}
        with patch.object(bridge,'CACHE',{}),patch.object(bridge,'PENDING',{}),ThreadPoolExecutor(max_workers=2) as pool:
            first=pool.submit(bridge.cached,'shared',read);self.assertTrue(started.wait(1))
            second=pool.submit(bridge.cached,'shared',read);release.set()
            self.assertEqual(first.result(),second.result());self.assertEqual(len(calls),1)

    def test_site_rate_limit_stops_followup_requests(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import MagicMock
        client=MagicMock();client.get.return_value.__enter__.return_value.status_code=429
        with tempfile.TemporaryDirectory() as directory:
            config=Path(directory)/'config.json';config.write_text('{"key":"test","siteSessionAuthorized":true}')
            with patch.object(bridge,'CONFIG_FILE',config),patch.object(bridge,'SITE_TIMING',{'last':0,'blockedUntil':0}),patch.object(bridge,'site_client',return_value=client),patch.object(bridge,'CACHE',{}),patch.object(bridge,'PENDING',{}):
                with self.assertRaises(PermissionError):bridge.site_json('/limited')
                with self.assertRaises(PermissionError):bridge.site_json('/another')
                self.assertEqual(client.get.call_count,1)
                self.assertGreater(json.loads(config.read_text())['siteBackoffUntil'],bridge.time.time())

    def test_directory_snapshot_is_bounded_and_excludes_private_responses(self):
        import tempfile
        from pathlib import Path
        from collections import OrderedDict
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'cache.gz'
            rows=OrderedDict({'catalog:https://public.test':(bridge.time.monotonic(),{'list':[1]},12),'/res/downurl/private':(bridge.time.monotonic(),{'secret':'not saved'},10)})
            with patch.object(bridge,'PUBLIC_CACHE_FILE',file),patch.object(bridge,'CACHE',rows):
                bridge.save_public_cache();rows.clear();bridge.load_public_cache()
                self.assertEqual(list(rows),['catalog:https://public.test'])

if __name__ == '__main__':
    unittest.main()

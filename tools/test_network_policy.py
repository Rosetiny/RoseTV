"""Offline checks: bounded requests/storage, publisher trust and complete batch metadata."""
import json
import tempfile
import unittest
from collections import OrderedDict
from pathlib import Path
from unittest.mock import Mock, patch
import rosetv_bridge as bridge


class NetworkPolicyChecks(unittest.TestCase):
    def setUp(self):
        for name in ('CACHE','PUBLIC_RECORDS'):
            replacement=patch.object(bridge,name,OrderedDict());replacement.start();self.addCleanup(replacement.stop)

    def test_local_budget_is_structured_and_does_not_pause_the_website(self):
        import threading,requests
        from http.server import ThreadingHTTPServer
        server=ThreadingHTTPServer(('127.0.0.1',0),bridge.Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with patch.object(bridge,'library',side_effect=bridge.LocalRequestBudget('douban',18)),patch.object(bridge,'pause_public_metadata') as pause,requests.Session() as client:
                client.trust_env=False;result=client.get('http://127.0.0.1:'+str(server.server_port)+'/library',headers={'X-RoseTV-Key':bridge.KEY},timeout=2)
                self.assertEqual(result.status_code,429);self.assertEqual(result.json()['code'],'local_budget');self.assertEqual(result.json()['retryAfterSeconds'],19);pause.assert_not_called()
        finally:server.shutdown();server.server_close();thread.join()

    def test_prefetch_leaves_two_foreground_slots_and_uses_existing_cache_for_free(self):
        with patch.object(bridge,'REQUEST_TIMES',{'douban':[100]*6,'site':[]}),patch.object(bridge.time,'time',return_value=110):
            with self.assertRaises(bridge.LocalRequestBudget):bridge.reserve_request('douban',background=True)
            self.assertEqual(len(bridge.REQUEST_TIMES['douban']),6)
            bridge.reserve_request('douban');bridge.reserve_request('douban')
            with self.assertRaises(bridge.LocalRequestBudget):bridge.reserve_request('douban')
        address='https://m.douban.com/rexxar/api/v2/movie/recommend?test=cached'
        with patch.object(bridge,'CACHE',OrderedDict()),patch.object(bridge,'PUBLIC_RECORDS',OrderedDict()),patch.object(bridge,'reserve_request',side_effect=AssertionError('Cached data spends no quota')):
            bridge.cached('catalog:'+address,lambda:{'items':[]})
            self.assertEqual(bridge.public_json(address,background=True),{'items':[]})

    def test_chart_cards_are_removed_before_slicing_without_extra_queries_or_missing_films(self):
        source=[{'id':'film_genre_42','type':'chart','title':'Chart'}]+[{'id':str(i),'type':'movie','title':'Film '+str(i)} for i in range(1,64)]
        responses={};calls=[]
        def read(address,**kwargs):
            if address not in responses:
                calls.append(address);start=int(bridge.url.parse_qs(bridge.url.urlsplit(address).query)['start'][0])
                count=int(bridge.url.parse_qs(bridge.url.urlsplit(address).query)['count'][0]);responses[address]={'total':len(source),'items':source[start:start+count]}
            return responses[address]
        with patch.object(bridge,'public_json',side_effect=read):
            results=[bridge.library('mv',page,16,{'genre':'儿童'},details=False,rich=True) for page in range(1,5)]
        self.assertEqual(len(results[0]['list']),16)
        self.assertEqual([len(row['list']) for row in results],[16,16,16,15])
        self.assertEqual([int(item['vod_id']) for result in results for item in result['list']],list(range(1,64)))
        self.assertEqual(len(calls),1);self.assertIn('非影片',results[1]['note'])
        with patch.object(bridge,'public_json',return_value={'total':17,'items':source[:17]}):
            exact=bridge.library('mv',1,16,{},details=False,rich=True)
            self.assertEqual(exact['pages'],1);self.assertFalse(exact['hasMore'])

    def test_anime_receives_year_area_and_genres_in_the_single_catalog_response(self):
        with patch.object(bridge,'public_json',return_value={'total':1,'items':[{'id':'123','title':'Anime','card_subtitle':'2026 / 日本 / 动画 奇幻'}]}) as read:
            data=bridge.library('ac',1,16,{},details=False,rich=True)
        read.assert_called_once();self.assertIn('/tv/recommend?',read.call_args.args[0]);self.assertIn('动漫',bridge.url.parse_qs(bridge.url.urlsplit(read.call_args.args[0]).query)['tags'][0])
        self.assertEqual((data['list'][0]['vod_year'],data['list'][0]['vod_area'],data['list'][0]['vod_class']),('2026','日本','动画 / 奇幻'))

    def test_capped_batches_still_fill_pages_without_looping_or_duplicates(self):
        source=[{'id':'chart'}]+[{'id':str(i),'title':str(i)} for i in range(1,160)]
        calls=[]
        def read(address,**kwargs):
            def load():
                calls.append(address);start=int(bridge.url.parse_qs(bridge.url.urlsplit(address).query)['start'][0])
                return {'items':source[start:start+32],'total':160}
            return bridge.cached('catalog:'+address,load)
        with patch.object(bridge,'public_json',side_effect=read):
            rows=[bridge.library('mv',n,16,{},rich=True,details=False) for n in range(1,7)]
            bridge.CACHE.clear()  # Simulate another memory-cache user; disk snapshot records remain.
            again=bridge.library('mv',2,16,{},rich=True,details=False)
        self.assertEqual([len(row['list']) for row in rows],[16]*6)
        self.assertEqual([int(v['vod_id']) for row in rows for v in row['list']],list(range(1,97)))
        self.assertEqual(len(calls),4);self.assertEqual(again['list'],rows[1]['list'])

    def test_public_api_rate_limit_stops_repeated_cross_filter_requests(self):
        import requests
        with tempfile.TemporaryDirectory() as directory,patch.object(bridge,'CONFIG_FILE',Path(directory)/'config.json'),patch.object(bridge,'CONFIG',{}),patch.object(bridge,'API_BACKOFF_UNTIL',{}),patch.object(bridge,'safe_url',side_effect=lambda value:value),patch.object(bridge.HTTP,'get') as get:
            get.return_value=Mock(status_code=429,headers={'Retry-After':'1800'})
            for index in range(100):
                with self.assertRaises(PermissionError):bridge.upstream('https://source.test/api.php/provide/vod/?ac=detail&pg='+str(index+1))
            self.assertEqual(get.call_count,1)
            self.assertGreater(bridge.API_BACKOFF_UNTIL['source.test']-bridge.time.time(),1790)

    def test_clear_api_cache_removes_only_response_data(self):
        import threading,requests
        from http.server import ThreadingHTTPServer
        server=ThreadingHTTPServer(('127.0.0.1',0),bridge.Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                snapshot=Path(directory)/'catalog.gz';snapshot.write_bytes(b'cache')
                account=Path(directory)/'session.bin';account.write_bytes(b'keep account')
                config=Path(directory)/'config.json';config.write_text('{"setting":"keep"}')
                with patch.object(bridge,'PUBLIC_CACHE_FILE',snapshot),patch.object(bridge,'SESSION_FILE',account),patch.object(bridge,'CONFIG_FILE',config),patch.object(bridge,'CACHE',OrderedDict([('api:one',(0,{},2))])),patch.object(bridge,'PUBLIC_RECORDS',OrderedDict([('catalog:one',(0,{},2))])),requests.Session() as client:
                    client.trust_env=False;result=client.get('http://127.0.0.1:'+str(server.server_port)+'/clear-cache',headers={'X-RoseTV-Key':bridge.KEY},timeout=2)
                    self.assertEqual(result.status_code,200);self.assertFalse(snapshot.exists());self.assertEqual(len(bridge.CACHE)+len(bridge.PUBLIC_RECORDS),0)
                    self.assertEqual(account.read_bytes(),b'keep account');self.assertEqual(json.loads(config.read_text()),{'setting':'keep'})
        finally:server.shutdown();server.server_close();thread.join()

    def test_verification_html_pauses_requests_without_retrying_or_caching_empty_data(self):
        from unittest.mock import MagicMock
        response=MagicMock();response.__enter__.return_value=response;response.iter_content.return_value=[b'<html>captcha challenge-platform</html>']
        def pause(_):bridge.DOUBAN_TIMING['blockedUntil']=bridge.time.monotonic()+900
        with patch.object(bridge,'CACHE',OrderedDict()),patch.object(bridge,'PUBLIC_RECORDS',OrderedDict()),patch.object(bridge,'DOUBAN_TIMING',{'last':0,'blockedUntil':0}),patch.object(bridge,'REQUEST_TIMES',{'douban':[],'site':[]}),patch.object(bridge,'pause_public_metadata',side_effect=pause) as cooldown,patch.object(bridge,'upstream',return_value=response) as upstream:
            for _ in range(2):
                with self.assertRaises(PermissionError):bridge.public_json('https://movie.douban.com/j/new_search_subjects?test=challenge')
            self.assertEqual(upstream.call_count,1);cooldown.assert_called_once_with(response);self.assertEqual(len(bridge.PUBLIC_RECORDS),0)

    def test_closed_view_drops_queued_douban_request_before_spending_budget(self):
        import socket,time,threading,requests
        from http.server import ThreadingHTTPServer
        from unittest.mock import MagicMock
        server=ThreadingHTTPServer(('127.0.0.1',0),bridge.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        response=MagicMock();response.__enter__.return_value=response
        response.iter_content.return_value=[b'{"data":[]}']
        try:
            with patch.object(bridge,'CACHE',OrderedDict()),patch.object(bridge,'PUBLIC_RECORDS',OrderedDict()),patch.object(bridge,'PENDING',{}),patch.object(bridge,'DOUBAN_TIMING',{'last':time.monotonic(),'blockedUntil':0}),patch.object(bridge,'DOUBAN_QUEUE',{'foreground':0,'active':False}),patch.object(bridge,'REQUEST_TIMES',{'douban':[],'site':[]}),patch.object(bridge,'upstream',return_value=response) as upstream:
                connection=socket.create_connection(('127.0.0.1',server.server_port),timeout=2)
                connection.sendall(('GET /library?kind=mv&limit=16 HTTP/1.1\r\nHost: localhost\r\nX-RoseTV-Key: '+bridge.KEY+'\r\n\r\n').encode())
                end=time.monotonic()+2
                while not bridge.DOUBAN_QUEUE['active'] and time.monotonic()<end:time.sleep(.01)
                self.assertTrue(bridge.DOUBAN_QUEUE['active'])
                connection.close();end=time.monotonic()+1
                while bridge.DOUBAN_QUEUE['active'] and time.monotonic()<end:time.sleep(.01)
                self.assertFalse(bridge.DOUBAN_QUEUE['active'])
                upstream.assert_not_called();self.assertEqual(bridge.REQUEST_TIMES['douban'],[])
                bridge.DOUBAN_TIMING['last']=0
                with requests.Session() as client:
                    client.trust_env=False
                    result=client.get('http://127.0.0.1:'+str(server.server_port)+'/library?kind=mv&limit=16',headers={'X-RoseTV-Key':bridge.KEY},timeout=2)
                self.assertEqual(result.status_code,200);self.assertEqual(upstream.call_count,1)
        finally:server.shutdown();server.server_close();thread.join()

    def test_fifty_superseded_views_send_only_the_last_queued_request(self):
        import socket,time,threading
        from http.server import ThreadingHTTPServer
        from unittest.mock import MagicMock
        server=ThreadingHTTPServer(('127.0.0.1',0),bridge.Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        response=MagicMock();response.__enter__.return_value=response;response.iter_content.return_value=[b'{"items":[],"total":0}']
        try:
            with patch.object(bridge,'CACHE',OrderedDict()),patch.object(bridge,'PUBLIC_RECORDS',OrderedDict()),patch.object(bridge,'PENDING',{}),patch.object(bridge,'DOUBAN_TIMING',{'last':time.monotonic(),'blockedUntil':0}),patch.object(bridge,'DOUBAN_QUEUE',{'foreground':0,'active':False}),patch.object(bridge,'REQUEST_TIMES',{'douban':[],'site':[]}),patch.object(bridge,'upstream',return_value=response) as upstream:
                previous=None
                for index in range(50):
                    connection=socket.create_connection(('127.0.0.1',server.server_port),timeout=8)
                    connection.sendall(('GET /library?kind=mv&rich=1&year='+str(1900+index)+' HTTP/1.1\r\nHost: localhost\r\nX-RoseTV-Key: '+bridge.KEY+'\r\n\r\n').encode())
                    if previous:previous.close()
                    previous=connection;time.sleep(.005)
                body=b''
                while True:
                    chunk=previous.recv(65536)
                    if not chunk:break
                    body+=chunk
                previous.close();self.assertIn(b'200 OK',body)
                self.assertEqual(upstream.call_count,1);self.assertEqual(len(bridge.REQUEST_TIMES['douban']),1)
        finally:server.shutdown();server.server_close();thread.join()

    def test_visible_mobile_catalog_keeps_foreground_priority(self):
        from contextlib import contextmanager
        from unittest.mock import MagicMock
        priorities=[]
        @contextmanager
        def turn(background):
            priorities.append(background);yield
        response=MagicMock();response.__enter__.return_value=response;response.iter_content.return_value=[b'{"items":[]}']
        with patch.object(bridge,'CACHE',OrderedDict()),patch.object(bridge,'PUBLIC_RECORDS',OrderedDict()),patch.object(bridge,'DOUBAN_TIMING',{'last':0,'blockedUntil':0}),patch.object(bridge,'REQUEST_TIMES',{'douban':[],'site':[]}),patch.object(bridge,'douban_turn',turn),patch.object(bridge,'upstream',return_value=response):
            bridge.public_json('https://m.douban.com/rexxar/api/v2/movie/recommend?test=foreground')
        self.assertEqual(priorities,[False])

    def test_focus_preserves_maximized_window_and_restores_only_when_minimized(self):
        import threading
        import requests
        from http.server import ThreadingHTTPServer
        server=ThreadingHTTPServer(('127.0.0.1',0),bridge.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        user=Mock();user.IsIconic.side_effect=[False,True];user.IsZoomed.return_value=True
        try:
            with patch.object(bridge,'window_handle',return_value=42),patch.object(bridge.ctypes.windll,'user32',user),requests.Session() as client:
                client.trust_env=False
                for index in range(2):
                    response=client.get('http://127.0.0.1:'+str(server.server_port)+'/window/focus',headers={'X-RoseTV-Key':bridge.KEY},timeout=3)
                    self.assertEqual(response.status_code,200)
                    if index==0:user.ShowWindow.assert_not_called()
                user.ShowWindow.assert_called_once_with(42,9)
                self.assertEqual(user.SetForegroundWindow.call_count,2)
        finally:server.shutdown();server.server_close();thread.join()

    def test_relay_conditional_images_and_seek_ranges_preserve_http_semantics(self):
        import io
        from unittest.mock import MagicMock
        handler=object.__new__(bridge.Handler);handler.headers={'If-None-Match':'"poster-v1"'};handler.wfile=io.BytesIO()
        handler.send_response=Mock();handler.send_header=Mock();handler.end_headers=Mock()
        response=MagicMock(status_code=304,headers={'ETag':'"poster-v1"'})
        response.__enter__.return_value=response
        with patch.object(bridge,'upstream',return_value=response) as upstream:
            handler.relay('https://cdn.test/poster.jpg')
            self.assertEqual(upstream.call_args.args[2]['If-None-Match'],'"poster-v1"')
        handler.send_response.assert_called_once_with(304);response.iter_content.assert_not_called();self.assertEqual(handler.wfile.getvalue(),b'')
        handler.send_response.reset_mock();handler.send_header.reset_mock();handler.headers={'Range':'bytes=4-7','If-Range':'"movie-v1"'}
        response=MagicMock(status_code=206,headers={'Content-Type':'video/mp4','Content-Length':'4','Content-Range':'bytes 4-7/10','Accept-Ranges':'bytes','ETag':'"movie-v1"'})
        response.__enter__.return_value=response;response.iter_content.return_value=iter([b'4567'])
        with patch.object(bridge,'upstream',return_value=response) as upstream:
            handler.relay('https://cdn.test/movie.mp4',video=True)
            self.assertEqual(upstream.call_args.args[2]['Range'],'bytes=4-7');self.assertEqual(upstream.call_args.args[2]['If-Range'],'"movie-v1"')
        handler.send_response.assert_called_once_with(206);handler.send_header.assert_any_call('Content-Range','bytes 4-7/10');self.assertEqual(handler.wfile.getvalue(),b'4567')

    def test_request_budget_and_retry_after(self):
        with patch.object(bridge,'REQUEST_TIMES',{'douban':[],'site':[]}),patch.object(bridge.time,'time',return_value=100):
            for _ in range(8):bridge.reserve_request('douban')
            with self.assertRaises(PermissionError):bridge.reserve_request('douban')
            bridge.reserve_request('site')
        self.assertEqual(bridge.retry_delay(Mock(headers={'Retry-After':'1800'})),1800)
        self.assertEqual(bridge.retry_delay(Mock(headers={'Retry-After':'2'})),900)

    def test_catalog_survives_hot_cache_eviction_and_restart_with_a_size_limit(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(bridge,'PUBLIC_CACHE_FILE',Path(directory)/'catalog.gz'),patch.object(bridge,'CACHE',OrderedDict()),patch.object(bridge,'PUBLIC_RECORDS',OrderedDict()):
            bridge.cached('catalog:one',lambda:{'data':[{'id':1}]})
            for index in range(90):bridge.cached('api:'+str(index),lambda:{'list':[]})
            self.assertNotIn('catalog:one',bridge.CACHE)
            self.assertEqual(bridge.cached('catalog:one',lambda: self.fail('must reuse persistent catalog'))['data'][0]['id'],1)
            bridge.save_public_cache();bridge.PUBLIC_RECORDS.clear();bridge.CACHE.clear();bridge.load_public_cache()
            self.assertIn('catalog:one',bridge.PUBLIC_RECORDS)
            for index in range(520):bridge.cached('catalog:'+str(index),lambda:{'data':[]})
            self.assertLessEqual(len(bridge.PUBLIC_RECORDS),512)
            self.assertLessEqual(sum(row[2] for row in bridge.PUBLIC_RECORDS.values()),8*1024*1024)

    def test_two_display_pages_share_one_complete_metadata_batch(self):
        responses={};calls=[]
        def read(address,**kwargs):
            if address not in responses:
                calls.append(address)
                start=int(bridge.url.parse_qs(bridge.url.urlsplit(address).query)['start'][0])
                count=int(bridge.url.parse_qs(bridge.url.urlsplit(address).query)['count'][0]);responses[address]={'total':320,'items':[{'id':str(i+1),'title':'Film '+str(i),'year':'2000','card_subtitle':'2000 / 美国 / 剧情 犯罪'} for i in range(start,start+count)]}
            return responses[address]
        with patch.object(bridge,'public_json',side_effect=read):
            first=bridge.library('mv',1,16,{},details=False,rich=True)
            second=bridge.library('mv',2,16,{},details=False,rich=True)
        self.assertEqual(len(calls),1)
        self.assertEqual([int(row['vod_id']) for row in first['list']+second['list']],list(range(1,33)))
        self.assertTrue(all(row['vod_area']=='美国' and row['vod_class']=='剧情 / 犯罪' for row in first['list']))
        with patch.object(bridge,'public_json',side_effect=read):
            bridge.library('mv',8,16,{},details=False,rich=True)
            bridge.library('mv',9,16,{},details=False,rich=True,background=True)
            bridge.library('mv',10,16,{},details=False,rich=True,background=True)
        self.assertEqual(len(calls),3,'Cold direct jumps build stable cursors once; new 64-item batches serve four display pages')

    def test_language_uses_real_fields_with_two_calls_max_and_resumes_exactly(self):
        def read(address):
            return {'list':[{'vod_id':str(i),'vod_name':str(i),'vod_lang':'国语' if i%2==0 else '英语','vod_class':'剧情'} for i in range(20)],'pagecount':10}
        with patch.object(bridge,'public_json',side_effect=read) as upstream:
            first=bridge.source_filter_catalog('mv',1,8,{'lang':'汉语普通话'})
            self.assertEqual(upstream.call_count,1)
            second=bridge.source_filter_catalog('mv',2,2,{'lang':'汉语普通话','cursor':str(first['nextCursor'])})
        self.assertEqual([row['vod_id'] for row in first['list']+second['list']],[str(i) for i in range(0,20,2)])
        self.assertNotIn('douban.com',upstream.call_args.args[0])

    def test_topic_language_uses_catalog_tags_and_never_scans_recent_source_pages(self):
        with patch.object(bridge,'public_json',return_value={'total':17,'items':[{'id':'2010975','title':'Film','card_subtitle':'2008 / 澳大利亚 美国 / 剧情 爱情'}]}) as upstream,patch.object(bridge,'source_filter_catalog',side_effect=AssertionError('Do not narrow the catalog to a recent source sample')):
            result=bridge.library('mv',1,16,{'genre':'文艺','lang':'英语'},details=False,rich=True)
        query=bridge.url.parse_qs(bridge.url.urlsplit(upstream.call_args.args[0]).query)
        self.assertEqual(query['tags'],['电影,文艺,英语']);self.assertEqual(result['list'][0]['vod_id'],'2010975');self.assertNotIn('nextCursor',result)

    def test_and_genres_keep_language_region_year_rating_and_sort(self):
        with patch.object(bridge,'public_json',return_value={'total':0,'items':[]}) as upstream:
            result=bridge.library('mv',1,16,{'genre':'文艺,爱情','genreMode':'all','lang':'英语','region':'英国','year':'2007','rating':'8','sort':'S'},details=False,rich=True)
        query=bridge.url.parse_qs(bridge.url.urlsplit(upstream.call_args.args[0]).query)
        self.assertEqual(set(query['tags'][0].split(',')),{'电影','文艺','爱情','英语','英国','2007'});self.assertEqual(query['score_range'],['8,10']);self.assertEqual(query['sort'],['S']);self.assertEqual(result['emptyReason'],'language-index')

    def test_unsupported_topic_source_combinations_do_not_make_futile_requests(self):
        with patch.object(bridge,'public_json',side_effect=AssertionError('Unsupported combinations must not query upstream')):
            for extra in ({'quality':'1080'},{'status':'finished'},{'genreMode':'any'},{'genreMode':'exclude'}):
                result=bridge.library('mv',1,16,{'genre':'文艺','lang':'英语',**extra},details=False,rich=True)
                self.assertEqual(result['unsupportedFilters'],['文艺']);self.assertEqual(result['pages'],1)

    def test_excluding_early_versions_still_works_with_advanced_cross_filters(self):
        filters={'genre':'剧情,动作','genreMode':'any','quality':'clear','lang':'英语','region':'美国','rating':'7'}
        base={'vod_name':'Film','vod_class':'剧情','vod_lang':'英语','vod_area':'美国','vod_douban_score':'8.0'}
        self.assertTrue(bridge.matches_catalog_filters(base,filters))
        for version in ('TC','TS','CAM','抢先版','枪版'):
            self.assertFalse(bridge.matches_catalog_filters({**base,'vod_remarks':version},filters))

    def test_publisher_discovery_is_daily_and_does_not_copy_sessions_or_follow_challenges(self):
        with tempfile.TemporaryDirectory() as directory:
            config=Path(directory)/'config.json';config.write_text('{}')
            response=Mock(status_code=200);response.__enter__=Mock(return_value=response);response.__exit__=Mock()
            response.iter_content.return_value=[b'<meta http-equiv="refresh" content="1;url=/auth">']
            with patch.object(bridge,'CONFIG',{}),patch.object(bridge,'CONFIG_FILE',config),patch.object(bridge,'REQUEST_TIMES',{'douban':[],'site':[]}),patch.object(bridge,'DOUBAN_TIMING',{'blockedUntil':0}),patch.object(bridge,'SITE_TIMING',{'blockedUntil':0}),patch.object(bridge.HTTP,'get',return_value=response) as get,patch.object(bridge,'site_client',side_effect=AssertionError('No account cookies during discovery')):
                old=bridge.SITE;result=bridge.refresh_provider_addresses();bridge.refresh_provider_addresses()
                self.assertEqual(get.call_count,2)
                self.assertEqual(bridge.SITE,old)
                self.assertIn('保留原地址',result['discovery']['message'])
                self.assertFalse(get.call_args.kwargs['allow_redirects'])


if __name__=='__main__':unittest.main()

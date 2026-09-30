import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch
from flask import Flask
from app.player_cache_policy import allowed_player_url, MAX_SCRIPT_BYTES
from app.player_script_cache import PlayerScriptCache

ROOT = Path(__file__).resolve().parents[2]
URL = 'https://www.youtube.com/s/player/abcd1234/player_ias.vflset/en_US/base.js'
package = types.ModuleType('md_test_plugin')
package.__path__ = [str(ROOT/'plugins/mediadrop/yt_dlp_plugins/extractor')]
sys.modules['md_test_plugin'] = package
spec = importlib.util.spec_from_file_location('md_test_plugin.mediadrop_player', package.__path__[0]+'/mediadrop_player.py')
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class PlayerCacheTests(unittest.TestCase):
    def test_source_policy(self):
        self.assertTrue(allowed_player_url(URL))
        for bad in [URL.replace('https:', 'http:'), URL.replace('www.youtube.com','www.youtube.com.evil.test'),
                    URL.replace('www.youtube.com','user@www.youtube.com'), URL+'?token=x', URL+'#x',
                    URL.replace('/base.js','/../base.js'), URL.replace('/base.js','/%2e%2e/base.js'),
                    URL.replace('www.youtube.com','www.youtube.com:443'), URL+'\n', None, 'file:///x']:
            self.assertFalse(allowed_player_url(bad), bad)
        self.assertEqual((ROOT/'app/player_cache_policy.py').read_bytes(),
            (ROOT/'plugins/mediadrop/yt_dlp_plugins/extractor/_mediadrop_policy.py').read_bytes())

    def test_ttl_budget_version_and_concurrent_access(self):
        now = [0]
        cache = PlayerScriptCache(clock=lambda:now[0], ttl=5, budget=20, limit=2)
        def op(action, version='v1', code=None):
            return cache.operation(dict(action=action,url=URL,version=version,code=code))
        op('put',code='x'*10)
        self.assertIsNone(op('get',version='v2')['code'])
        now[0]=5
        self.assertIsNone(op('get')['code'])
        with self.assertRaises(ValueError):op('put',code='x'*21)
        def task(i):op('put',version=str(i),code='1234567890')
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:list(pool.map(task,range(100)))
        self.assertLessEqual(cache.bytes,20);self.assertLessEqual(len(cache.entries),2)
        op('discard',version='99');self.assertIsNone(op('get',version='99')['code'])

    def test_ipc_requires_separate_secret_loopback_host_no_browser_origin(self):
        app=Flask(__name__);cache=PlayerScriptCache();cache.port=12345;cache.install(app)
        client=app.test_client();body=dict(action='put',url=URL,version='v1',code='public script')
        headers={'X-MediaDrop-Player-Token':cache.token}
        def post(**kw):return client.post('/internal/player-cache',base_url='http://127.0.0.1:12345',json=body,**kw)
        self.assertEqual(post().status_code,403)
        self.assertEqual(post(headers={'X-MediaDrop-Player-Token':'wrong'}).status_code,403)
        self.assertEqual(post(headers={**headers,'Origin':'https://evil.test'}).status_code,403)
        self.assertEqual(post(headers=headers,environ_overrides={'REMOTE_ADDR':'192.0.2.1'}).status_code,403)
        self.assertEqual(post(headers={**headers,'Host':'evil.test'}).status_code,403)
        self.assertEqual(post(headers=headers).status_code,200)
        body['action']='get';response=post(headers=headers)
        self.assertEqual(response.json['code'],'public script');self.assertEqual(response.headers['Cache-Control'],'no-store')
        body['url']='https://evil.test/code.js';self.assertEqual(post(headers=headers).status_code,400)
        response=client.post('/internal/player-cache',base_url='http://127.0.0.1:12345',headers=headers,
                             data=b'{}',environ_overrides={'CONTENT_LENGTH':str(10*1024*1024)})
        self.assertEqual(response.status_code,413)

    def test_plugin_rejects_remote_ipc_and_does_not_follow_redirects(self):
        ie=plugin.YoutubeMediaDropPlayerIE()
        with patch.dict(os.environ,{'MEDIADROP_PLAYER_CACHE_URL':'https://evil.test/internal/player-cache',
                                    'MEDIADROP_PLAYER_CACHE_TOKEN':'secret'}),patch.object(plugin.urllib.request,'build_opener') as opener:
            self.assertIsNone(ie._ipc('get',URL));opener.assert_not_called()
        self.assertIsNone(plugin.NoRedirect().redirect_request(None,None,302,'',{},'http://evil.test'))
        with patch.dict(os.environ,{'MEDIADROP_PLAYER_CACHE_URL':'http://127.0.0.1:12345/internal/player-cache',
                                    'MEDIADROP_PLAYER_CACHE_TOKEN':'secret'}),patch.object(plugin.urllib.request,'build_opener',side_effect=OSError) as opener:
            self.assertIsNone(ie._ipc('get',URL))
            self.assertEqual(opener.call_args.args[0].proxies,{})

    def test_untrusted_final_response_never_enters_cache(self):
        ie=plugin.YoutubeMediaDropPlayerIE();ie._code_cache={};ie._md_used=set();ie.get_param=Mock(return_value=False)
        ie._ipc=Mock(return_value=None)
        ie._download_webpage_handle=Mock(return_value=('script',types.SimpleNamespace(url='https://evil.test/code.js')))
        with patch.dict(os.environ,{'MEDIADROP_PLAYER_CACHE_TOKEN':'secret'}):
            self.assertEqual(ie._load_player('id',URL),'script')
        self.assertEqual([c.args[0] for c in ie._ipc.call_args_list],['get'])

    def test_cache_hit_skips_fetch_but_invalid_formats_retry_once(self):
        ie=plugin.YoutubeMediaDropPlayerIE();ie._code_cache={};ie._player_cache={};ie.get_param=Mock(return_value=False)
        ie._ipc=Mock(return_value={'code':'public script'});ie.write_debug=Mock()
        good={'formats':[{'vcodec':'av01'}]}
        calls=[]
        def extraction(_):
            calls.append(1)
            if len(calls)==1:
                self.assertEqual(ie._load_player('id',URL),'public script')
                return {'formats':[{'vcodec':'images','acodec':'none'}]}
            self.assertTrue(ie._md_bypass)
            return good
        with patch.dict(os.environ,{'MEDIADROP_PLAYER_CACHE_TOKEN':'secret'}),patch.object(plugin.YoutubeIE,'_real_extract',side_effect=extraction):
            self.assertEqual(ie._real_extract('video'),good)
        self.assertEqual(len(calls),2)
        self.assertIn('discard',[c.args[0] for c in ie._ipc.call_args_list])
        def failing(_):
            ie._md_used.add(URL)
            raise RuntimeError('failed')
        with patch.object(plugin.YoutubeIE,'_real_extract',side_effect=failing) as extract:
            with self.assertRaises(RuntimeError):ie._real_extract('video')
            self.assertEqual(extract.call_count,2)

    def test_challenge_warning_with_partial_formats_also_refreshes(self):
        ie=plugin.YoutubeMediaDropPlayerIE();ie._code_cache={};ie._player_cache={}
        ie._ipc=Mock();ie.write_debug=Mock();calls=[]
        def extraction(_):
            calls.append(1)
            if len(calls)==1:
                ie._md_used.add(URL)
                ie.report_warning('Signature extraction failed: some formats may be missing')
            return {'formats':[{'vcodec':'avc1'}]}
        with patch.object(plugin.YoutubeIE,'_real_extract',side_effect=extraction),patch.object(plugin.YoutubeIE,'report_warning'):
            ie._real_extract('video')
        self.assertEqual(len(calls),2)

import json
import os
import tempfile
import unittest
from unittest.mock import patch
from app.info_cache import InfoCache
from app import app as server


class InfoCacheTests(unittest.TestCase):
    def test_expiry_and_independent_format_selection(self):
        now=[0];cache=InfoCache(clock=lambda:now[0],ttl=5)
        source={'formats':[{'format_id':'hi'}],'requested_formats':[{'format_id':'old'}],'requested_downloads':[{}]}
        cache.put('a',source)
        value=json.loads(cache.get('a'))
        self.assertNotIn('requested_formats',value)
        self.assertNotIn('requested_downloads',value)
        self.assertIn('requested_formats',source)
        now[0]=5;self.assertIsNone(cache.get('a'));self.assertEqual(cache.size,0)

    def test_bounds_and_live_exclusion(self):
        cache=InfoCache(max_entries=2,max_bytes=200)
        for key in 'abc':cache.put(key,{'formats':[{}]})
        self.assertIsNone(cache.get('a'))
        cache.put('large',{'formats':['x'*201]});self.assertIsNone(cache.get('large'))
        cache.put('live',{'formats':[{}],'is_live':True});self.assertIsNone(cache.get('live'))
        cache.discard('c');self.assertIsNone(cache.get('c'))

    def test_cache_scope_and_command_reuse(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(server,'get_base_dir',return_value='/isolated'), patch.object(server,'load_config',return_value={'cookies_browser':'chrome','proxy_url':'http://proxy:80'}):
            cache=InfoCache()
            with patch.object(server,'media_info_cache',cache):
                key=server.info_cache_key('https://example.com/video','sabr')
                cache.put(key,{'formats':[{}]})
                command=['engine','-f','bestvideo','https://example.com/video']
                result,hit=server.cached_download_command(command,command[-1],{'youtube_engine':'sabr'},directory)
                self.assertEqual(hit,key);self.assertNotEqual(result[-1],command[-1])
                self.assertEqual(result[-2],'--load-info-json')
                self.assertEqual(command[-1],'https://example.com/video')
                if os.name!='nt':self.assertEqual(os.stat(result[-1]).st_mode & 0o777,0o600)
                self.assertIsNone(server.cached_download_command(command,command[-1],{'youtube_engine':'standard'},directory)[1])
                with patch.object(server,'load_config',return_value={'cookies_browser':'firefox','proxy_url':'http://proxy:80'}):
                    self.assertIsNone(server.cached_download_command(command,command[-1],{'youtube_engine':'sabr'},directory)[1])

    def test_cookie_file_modification_invalidates(self):
        with tempfile.NamedTemporaryFile() as file, patch.object(server,'get_base_dir',return_value='/isolated'):
            cfg={'cookies_file':file.name}
            before=server.info_cache_key('url','standard',cfg=cfg)
            file.write(b'new');file.flush()
            self.assertNotEqual(before,server.info_cache_key('url','standard',cfg=cfg))

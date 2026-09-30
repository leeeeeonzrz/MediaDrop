"""Reuse public player source in the parent app's RAM; never cache login or JS results."""
import json
import os
import urllib.request
from urllib.parse import urlsplit
from yt_dlp.extractor.youtube import YoutubeIE
from yt_dlp.version import __version__
from ._mediadrop_policy import allowed_player_url, MAX_SCRIPT_BYTES


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class YoutubeMediaDropPlayerIE(YoutubeIE, plugin_name='mediadrop_player'):
    def _ipc(self, action, url, code=None):
        endpoint = os.environ.get('MEDIADROP_PLAYER_CACHE_URL', '')
        token = os.environ.get('MEDIADROP_PLAYER_CACHE_TOKEN', '')
        try:
            parsed = urlsplit(endpoint)
            if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1'
                    or not parsed.port or parsed.username or parsed.password or parsed.query
                    or parsed.fragment or parsed.path != '/internal/player-cache' or not token):
                return None
            body = json.dumps({'action': action, 'url': url, 'version': __version__, 'code': code}).encode()
            req = urllib.request.Request(endpoint, data=body, headers={
                'Content-Type': 'application/json', 'X-MediaDrop-Player-Token': token})
            # Never send the private credential through a configured proxy or redirect.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            with opener.open(req, timeout=1) as response:
                raw = response.read(9*1024*1024+1)
                if len(raw) > 9*1024*1024:
                    return None
                result = json.loads(raw)
                return result if isinstance(result, dict) else None
        except (OSError, ValueError, TypeError):
            return None

    def _real_extract(self, url):
        self._md_used = set()
        self._md_bypass = False
        self._md_challenge_failed = False
        try:
            result = super()._real_extract(url)
            if self._md_used and (self._md_challenge_failed or not any(
                    f.get('vcodec') not in (None, 'none', 'images')
                    or f.get('acodec') not in (None, 'none') for f in result.get('formats', []))):
                raise ValueError('Cached player validation failed')
            return result
        except Exception:
            if not self._md_used:
                raise
            for player_url in self._md_used:
                self._ipc('discard', player_url)
            self._md_bypass = True
            self._code_cache.clear()
            self._player_cache.clear()
            self.write_debug('MEDIADROP_PLAYER_CACHE_RETRY')
            # One fresh extraction only. An error here propagates normally.
            return super()._real_extract(url)

    def report_warning(self, message, *args, **kwargs):
        lowered = str(message).lower()
        if any(marker in lowered for marker in ('challenge solving failed', 'nsig extraction failed',
                                                'signature extraction failed')):
            self._md_challenge_failed = True
        return super().report_warning(message, *args, **kwargs)

    def _load_player(self, video_id, player_url, fatal=True):
        if (getattr(self, '_md_bypass', False) or not allowed_player_url(player_url)
                or self.get_param('nocheckcertificate')
                or not os.environ.get('MEDIADROP_PLAYER_CACHE_TOKEN')):
            return super()._load_player(video_id, player_url, fatal=fatal)
        hit = self._ipc('get', player_url)
        code = hit.get('code') if hit else None
        key = self._player_js_cache_key(player_url)
        if isinstance(code, str) and code and len(code.encode()) <= MAX_SCRIPT_BYTES:
            self._md_used.add(player_url)
            self._code_cache[key] = code
            self.write_debug('MEDIADROP_PLAYER_CACHE_HIT')
            return code
        if key in self._code_cache:
            return self._code_cache[key]
        result = self._download_webpage_handle(player_url, video_id, fatal=fatal,
            note=f'Downloading player {key}', errnote=f'Download of {key} failed')
        if not result:
            return None
        code, response = result
        if code:
            self._code_cache[key] = code
            # Only an exact, approved final HTTPS URL may seed the cache.
            if (response is not None and response.url == player_url
                    and allowed_player_url(response.url) and len(code.encode()) <= MAX_SCRIPT_BYTES):
                self._ipc('put', player_url, code)
        return code

"""Bounded RAM-only public script cache with a separate, per-launch IPC credential."""
import hmac
import json
import secrets
import threading
import time
from collections import OrderedDict
from flask import request, jsonify
try:
    from player_cache_policy import allowed_player_url, MAX_SCRIPT_BYTES
except ImportError:
    from app.player_cache_policy import allowed_player_url, MAX_SCRIPT_BYTES


class PlayerScriptCache:
    def __init__(self, clock=time.monotonic, ttl=86400, budget=32*1024*1024, limit=16):
        self.clock, self.ttl, self.budget, self.limit = clock, ttl, budget, limit
        self.entries = OrderedDict()
        self.bytes = 0
        self.lock = threading.Lock()
        self.token = secrets.token_urlsafe(32)
        self.port = None

    def _drop(self, key):
        value = self.entries.pop(key, None)
        if value:
            self.bytes -= value[2]

    def operation(self, payload):
        url, version = payload.get('url'), payload.get('version')
        if not allowed_player_url(url) or not isinstance(version, str) or not 0 < len(version) < 100:
            raise ValueError('Invalid cache key')
        key = (version, url)
        with self.lock:
            now = self.clock()
            for old in list(self.entries):
                if now - self.entries[old][0] >= self.ttl:
                    self._drop(old)
            action = payload.get('action')
            if action == 'get':
                entry = self.entries.get(key)
                if entry:
                    self.entries.move_to_end(key)
                return {'code': entry[1] if entry else None}
            if action == 'discard':
                self._drop(key)
                return {'ok': True}
            if action != 'put':
                raise ValueError('Invalid operation')
            code = payload.get('code')
            if not isinstance(code, str) or not code:
                raise ValueError('Invalid script')
            size = len(code.encode('utf-8'))
            if size > min(MAX_SCRIPT_BYTES, self.budget):
                raise ValueError('Script exceeds cache limit')
            self._drop(key)
            self.entries[key] = (now, code, size)
            self.bytes += size
            while self.bytes > self.budget or len(self.entries) > self.limit:
                self._drop(next(iter(self.entries)))
            return {'ok': True}

    def environment(self):
        if self.port is None:
            return {}
        return {'MEDIADROP_PLAYER_CACHE_URL': f'http://127.0.0.1:{self.port}/internal/player-cache',
                'MEDIADROP_PLAYER_CACHE_TOKEN': self.token}

    def install(self, app):
        @app.post('/internal/player-cache')
        def player_cache_ipc():
            # A browser session cookie is deliberately insufficient. No CORS.
            supplied = request.headers.get('X-MediaDrop-Player-Token', '')
            if (request.remote_addr != '127.0.0.1' or request.headers.get('Origin')
                    or not hmac.compare_digest(supplied.encode(), self.token.encode())
                    or (self.port is not None and request.host != f'127.0.0.1:{self.port}')):
                return jsonify({'error': 'Forbidden'}), 403
            if request.content_length is None or request.content_length > 9*1024*1024:
                return jsonify({'error': 'Request too large'}), 413
            try:
                payload = json.loads(request.get_data())
                if not isinstance(payload, dict):
                    raise ValueError('Invalid body')
                result = self.operation(payload)
            except (ValueError, TypeError, UnicodeError):
                return jsonify({'error': 'Invalid cache request'}), 400
            response = jsonify(result)
            response.headers['Cache-Control'] = 'no-store'
            return response

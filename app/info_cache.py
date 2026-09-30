"""Bounded, short-lived metadata cache; signed media URLs never enter job history."""
import json
import threading
import time
from collections import OrderedDict


class InfoCache:
    def __init__(self, ttl=300, max_bytes=32*1024*1024, max_entries=24, clock=time.monotonic):
        self.ttl, self.max_bytes, self.max_entries, self.clock = ttl, max_bytes, max_entries, clock
        self.entries = OrderedDict()
        self.size = 0
        self.lock = threading.RLock()

    def _remove(self, key):
        entry = self.entries.pop(key, None)
        if entry:
            self.size -= len(entry[1])

    def put(self, key, info):
        if not isinstance(info, dict) or info.get('is_live') or not info.get('formats'):
            return
        # Re-select the requested output rather than carrying the parse-time default.
        info = dict(info)
        for field in ('requested_downloads', 'requested_formats', 'requested_subtitles', '__files_to_move'):
            info.pop(field, None)
        encoded = json.dumps(info, ensure_ascii=False).encode('utf-8')
        if len(encoded) > self.max_bytes:
            return
        with self.lock:
            self._remove(key)
            self.entries[key] = (self.clock(), encoded)
            self.size += len(encoded)
            while self.size > self.max_bytes or len(self.entries) > self.max_entries:
                self._remove(next(iter(self.entries)))

    def get(self, key):
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return None
            if self.clock() - entry[0] >= self.ttl:
                self._remove(key)
                return None
            self.entries.move_to_end(key)
            return entry[1]

    def discard(self, key):
        with self.lock:
            self._remove(key)

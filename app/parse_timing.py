"""Local bounded diagnostics: fixed phase names and durations, never raw output."""
import json
import os
import threading
import time

_lock = threading.Lock()
_markers = (
    ('cookies_start', 'Extracting cookies from'),
    ('cookies_done', 'Extracted '),
    ('webpage_start', 'Downloading webpage'),
    ('player_start', 'Downloading player'),
    ('player_api_start', 'Downloading web player API JSON'),
    ('challenge_start', 'Solving JS'),
    ('player_cache_hit', 'MEDIADROP_PLAYER_CACHE_HIT'),
    ('player_cache_retry', 'MEDIADROP_PLAYER_CACHE_RETRY'),
)


class ParseTiming:
    def __init__(self, authenticated, clock=time.monotonic):
        self.clock = clock
        self.started = clock()
        self.authenticated = authenticated
        self.events = []

    def observe(self, line):
        if len(self.events) >= 64:
            return
        for phase, marker in _markers:
            if marker in line:
                self.events.append({'phase': phase, 'seconds': round(self.clock()-self.started, 3)})

    def save(self, directory, returncode):
        record = {'recorded_at': int(time.time()), 'browser_cookies_requested': self.authenticated,
                  'seconds': round(self.clock()-self.started, 3), 'returncode': returncode,
                  'events': list(self.events)}
        path = os.path.join(directory, 'parse-timings.json')
        try:
            with _lock:
                try:
                    with open(path) as source:
                        records = json.load(source)
                    if not isinstance(records, list):
                        records = []
                except (OSError, ValueError):
                    records = []
                temporary = path + '.tmp'
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, 'w') as target:
                    json.dump((records + [record])[-20:], target, indent=2)
                os.replace(temporary, path)
        except OSError:
            pass

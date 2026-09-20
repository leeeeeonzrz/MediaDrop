"""Cancellation ownership for short-lived metadata extraction processes."""
import subprocess
import sys
import threading
import time
from contextlib import contextmanager


class ParseCancelled(Exception):
    pass


class ParseJobs:
    def __init__(self, terminate):
        self.terminate = terminate
        self.lock = threading.RLock()
        self.active = {}
        self.cancelled = {}

    @contextmanager
    def register(self, request_id):
        with self.lock:
            now = time.monotonic()
            self.cancelled = {key: expiry for key, expiry in self.cancelled.items() if expiry > now}
            if request_id in self.cancelled:
                raise ParseCancelled()
            if request_id in self.active:
                raise ValueError('Duplicate parse request')
            if len(self.active) >= 64:
                raise ValueError('Too many parse requests')
            state = {'cancelled': False, 'process': None}
            self.active[request_id] = state
        try:
            yield state
            if state['cancelled']:
                raise ParseCancelled()
        finally:
            with self.lock:
                self.active.pop(request_id, None)

    def cancel(self, request_id):
        with self.lock:
            # Keep a short tombstone when cancellation overtakes the original request.
            self.cancelled[request_id] = time.monotonic() + 120
            while len(self.cancelled) > 1024:
                self.cancelled.pop(next(iter(self.cancelled)))
            state = self.active.get(request_id)
            if state:
                state['cancelled'] = True
            process = state and state['process']
        if process is not None and process.poll() is None:
            self.terminate(process)

    def cancel_all(self):
        with self.lock:
            ids = list(self.active)
        for request_id in ids:
            self.cancel(request_id)

    def run(self, state, command, *, env, timeout=60, on_stderr=None):
        with self.lock:
            if state['cancelled']:
                raise ParseCancelled()
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, env=env, start_new_session=sys.platform != 'win32')
            state['process'] = process
        reader = None
        stderr_lines = []
        if on_stderr is not None:
            stream = process.stderr
            # communicate still owns stdout and timeout/cancellation. Only this
            # reader owns stderr, avoiding two consumers on the same pipe.
            process.stderr = None
            def read_stderr():
                try:
                    for line in stream:
                        stderr_lines.append(line)
                        try:
                            on_stderr(line)
                        except Exception:
                            pass  # Diagnostics must never fail extraction.
                finally:
                    stream.close()
            reader = threading.Thread(target=read_stderr, daemon=True)
            reader.start()
        try:
            stdout, stderr = process.communicate(timeout=timeout)
            if reader is not None:
                reader.join(timeout=5)
                stderr = ''.join(stderr_lines)
            if state['cancelled']:
                raise ParseCancelled()
            return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
        finally:
            if process.poll() is None:
                self.terminate(process)
                process.communicate(timeout=5)
            if reader is not None:
                reader.join(timeout=5)
            with self.lock:
                state['process'] = None

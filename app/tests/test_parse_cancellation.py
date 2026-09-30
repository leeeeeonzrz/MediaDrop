import atexit
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from app import app as server
from app.parse_jobs import ParseCancelled, ParseJobs

atexit.unregister(server.cleanup_all_jobs)


class ParseCancellationTests(unittest.TestCase):
    def test_cancel_before_registration(self):
        jobs = ParseJobs(server.terminate_process_tree)
        jobs.cancel('before')
        with self.assertRaises(ParseCancelled):
            with jobs.register('before'):
                self.fail('Cancelled request started')
        self.assertEqual(jobs.active, {})

    def test_cancel_running_process_and_retry_independently(self):
        jobs = ParseJobs(server.terminate_process_tree)
        with tempfile.TemporaryDirectory() as directory:
            started = pathlib.Path(directory, 'started')
            finished = pathlib.Path(directory, 'finished')
            command = [sys.executable, '-c',
                       f'import pathlib,time; pathlib.Path({str(started)!r}).touch(); time.sleep(15); pathlib.Path({str(finished)!r}).touch()']
            errors = []
            def worker():
                try:
                    with jobs.register('one') as state:
                        jobs.run(state, command, env=os.environ.copy(), on_stderr=lambda line: None)
                except ParseCancelled:
                    errors.append('cancelled')
            thread = threading.Thread(target=worker)
            thread.start()
            deadline = time.monotonic() + 5
            while not started.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(started.exists())
            jobs.cancel('one')
            thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, ['cancelled'])
            self.assertFalse(finished.exists())
            self.assertEqual(jobs.active, {})
            with jobs.register('two') as state:
                result = jobs.run(state, [sys.executable, '-c', 'print("ok")'], env=os.environ.copy())
                self.assertEqual(result.stdout.strip(), 'ok')

    def test_timeout_cleans_registry_and_process(self):
        jobs = ParseJobs(server.terminate_process_tree)
        with self.assertRaises(subprocess.TimeoutExpired):
            with jobs.register('timeout') as state:
                jobs.run(state, [sys.executable, '-c', 'import time; time.sleep(15)'], env=os.environ.copy(), timeout=.1, on_stderr=lambda line: None)
        self.assertEqual(jobs.active, {})
        self.assertIsNone(state['process'])

    def test_api_cancel_before_info_and_validation(self):
        registry = ParseJobs(server.terminate_process_tree)
        with mock.patch.object(server, 'info_jobs', registry), mock.patch.object(server, 'API_TOKEN', ''):
            client = server.app.test_client()
            request_id = 'cancel_before_start_123'
            self.assertEqual(client.post(f'/api/info/{request_id}/cancel').status_code, 200)
            with mock.patch.object(server, 'get_extractor_command') as extractor:
                response = client.post('/api/info', json={'url':'https://example.com/video','request_id':request_id})
                self.assertEqual(response.status_code, 409)
                self.assertTrue(response.json['cancelled'])
                extractor.assert_not_called()
            self.assertEqual(client.post('/api/info', json={'request_id':[]}).status_code, 400)
            self.assertEqual(client.post('/api/info/short/cancel').status_code, 400)

    def test_duplicate_does_not_remove_original(self):
        jobs = ParseJobs(server.terminate_process_tree)
        with jobs.register('same') as original:
            with self.assertRaises(ValueError):
                with jobs.register('same'):
                    pass
            self.assertIs(jobs.active['same'], original)


if __name__ == '__main__':
    unittest.main()

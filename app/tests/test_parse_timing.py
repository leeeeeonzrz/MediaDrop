import json
import os
import sys
import tempfile
import unittest

from app.parse_jobs import ParseJobs
from app.parse_timing import ParseTiming


class ParseTimingTests(unittest.TestCase):
    def test_only_fixed_phase_names_are_saved_and_history_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            for _ in range(22):
                timer = ParseTiming(True)
                timer.observe('Extracting cookies from chrome secret-profile')
                timer.observe('Extracted 100 cookies: secret-cookie-value')
                timer.observe('https://example.com/?token=secret-token')
                timer.save(directory, 0)
            with open(os.path.join(directory, 'parse-timings.json')) as source:
                text = source.read()
            self.assertNotIn('secret', text)
            records = json.loads(text)
            self.assertEqual(len(records), 20)
            self.assertEqual([e['phase'] for e in records[-1]['events']], ['cookies_start', 'cookies_done'])

    def test_reader_preserves_both_pipes_and_callback_failure_is_harmless(self):
        jobs = ParseJobs(lambda process: process.kill())
        seen = []
        def observe(line):
            seen.append(line)
            raise RuntimeError('diagnostics failure')
        with jobs.register('test') as state:
            result = jobs.run(state, [sys.executable, '-c',
                'import sys; print("json-output"); print("diagnostic", file=sys.stderr)'],
                env=os.environ.copy(), timeout=5, on_stderr=observe)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), 'json-output')
        self.assertEqual(result.stderr.strip(), 'diagnostic')
        self.assertEqual(len(seen), 1)

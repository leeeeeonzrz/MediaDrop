import atexit
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import threading
import unittest
from unittest import mock
import zipfile

from app import app as server
from app import enhanced_engine as engines
from app import youtube_compat

atexit.unregister(server.cleanup_all_jobs)
VERSION = '2026.10.27.135913'
TEST_ENGINE_ASSET = ('yt-dlp_win.zip', 'yt-dlp.exe')


class EngineInstallTests(unittest.TestCase):
    def setUp(self):
        # Exercise the Windows archive fixture independently of the CI host.
        asset_patch = mock.patch.object(engines, 'engine_asset', return_value=TEST_ENGINE_ASSET)
        self.addCleanup(asset_patch.stop)
        asset_patch.start()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.bundled = self.base / 'bundle'
        self.bundled.mkdir()
        self.manager = engines.EngineManager(self.base / 'data', self.bundled)
        self.manager.bundled_binary.write_bytes(b'bundled')
        (self.bundled / 'manifest.json').write_text(json.dumps({'engine_version': '2026.09.01.000000', 'provider': '2.0.2'}))
        (self.bundled / 'server').mkdir()
        (self.bundled / 'server/package.json').write_text('{"version":"2.0.2"}')
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as bundle:
            bundle.writestr(engines.engine_asset()[1], b'new native engine')
            bundle.writestr('_internal/runtime.dll', b'runtime')
        self.archive = buffer.getvalue()
        checksum = hashlib.sha256(self.archive).hexdigest()
        self.ident = f'sabr:{VERSION}:{checksum}'
        self.release = {'id': self.ident, 'version': VERSION, 'sha256': checksum,
                        'size': len(self.archive), 'url': engines.RELEASE_BASE + engines.engine_asset()[0],
                        'binary': engines.engine_asset()[1], 'published_at': '2026-10-27T14:17:10Z',
                        'source': 'remote', 'installed': False, 'current': False, 'available': True}

    def download(self, url, limit, target=None, proxy=None):
        self.assertEqual(url, self.release['url'])
        target.write(self.archive)
        return len(self.archive)

    def prepare(self):
        with mock.patch.object(engines, 'remote_release', return_value=self.release), \
             mock.patch.object(engines, 'read_url', side_effect=self.download), \
             mock.patch.object(engines, 'verify_compatibility'):
            self.manager.prepare(self.ident)

    def test_install_is_immutable_selection_atomic_and_survives_restart(self):
        self.prepare()
        self.assertEqual(self.manager.local_status()['selected_id'], 'bundled')
        installed = self.manager._directory(self.ident)
        before = engines.sha256(installed / self.release['binary'])
        self.manager.activate(self.ident)
        restarted = engines.EngineManager(self.base / 'data', self.bundled)
        self.assertEqual(restarted.local_status()['current'], VERSION)
        self.assertEqual(restarted.selected_path(), installed / self.release['binary'])
        self.manager.activate('bundled')
        self.assertEqual(engines.sha256(installed / self.release['binary']), before)
        self.assertEqual(self.manager.local_status()['selected_id'], 'bundled')

    def test_storage_directory_keeps_long_dll_paths_within_windows_limit(self):
        relative = Path('_internal/curl_cffi.libs/libcurl-impersonate-ae864b926b0a86bfa3b18a664407a1ab.dll')
        # Reproduce a long application/profile root: the previous version+full
        # hash directory would exceed MAX_PATH, while the compact ID fits.
        suffix = '/tools/youtube-engines/' + self.release['sha256'][:24] + '/' + relative.as_posix()
        padding = 250 - len(str(self.base)) - 1 - len(suffix)
        if padding < 1:
            self.skipTest('Test parent directory is already too long')
        manager = engines.EngineManager(self.base / ('p' * padding), self.bundled)
        target = manager._directory(self.ident) / relative
        self.assertLessEqual(len(str(target)), 250)
        self.assertGreater(len(str(target)) + 65, 260)
        target.parent.mkdir(parents=True)
        target.write_bytes(b'runtime')
        self.assertTrue(target.is_file())

    def test_checksum_or_probe_failure_keeps_current_and_leaves_no_install(self):
        for failure in ('checksum', 'probe'):
            with self.subTest(failure=failure):
                release = dict(self.release)
                if failure == 'checksum':
                    release['sha256'] = '0' * 64
                with mock.patch.object(engines, 'remote_release', return_value=release), \
                     mock.patch.object(engines, 'read_url', side_effect=self.download), \
                     mock.patch.object(engines, 'verify_compatibility', side_effect=engines.EngineError('incompatible') if failure == 'probe' else None):
                    with self.assertRaises(engines.EngineError):
                        self.manager.prepare(self.ident)
                self.assertEqual(self.manager.local_status()['selected_id'], 'bundled')
                self.assertFalse(self.manager._directory(self.ident).exists())

    def test_corruption_and_malformed_metadata_fall_back_without_deleting_versions(self):
        self.prepare()
        self.manager.activate(self.ident)
        registry = self.manager._registry()
        for field, bad in [('version', '2020.01.01.000000'), ('sha256', '0'*64), ('binary', '../evil.exe')]:
            changed = json.loads(json.dumps(registry))
            changed['installed'][self.ident][field] = bad
            self.manager._save(changed)
            self.assertEqual(self.manager.local_status()['selected_id'], 'bundled')
            self.assertTrue(self.manager.local_status()['warning'])
        self.manager._save(registry)
        (self.manager._directory(self.ident) / '_internal/runtime.dll').write_bytes(b'tampered')
        self.assertEqual(self.manager.local_status()['selected_id'], 'bundled')
        self.assertFalse(self.manager.local_status()['releases'][1]['available'])
        self.assertTrue(self.manager._directory(self.ident).exists())

    def test_new_app_anchor_requires_revalidation_without_implicit_activation(self):
        self.prepare()
        self.manager.activate(self.ident)
        (self.bundled / 'server/package.json').write_text('{"version":"3.0.0"}')
        status = engines.EngineManager(self.base / 'data', self.bundled).local_status()
        self.assertEqual(status['selected_id'], 'bundled')
        self.assertTrue(status['releases'][1]['available'])
        self.assertTrue(status['releases'][1]['needs_validation'])
        with mock.patch.object(engines, 'verify_compatibility') as probe:
            self.manager.prepare(self.ident)
        probe.assert_called_once()
        self.assertEqual(self.manager.local_status()['selected_id'], 'bundled')
        self.manager.activate(self.ident)
        self.assertEqual(self.manager.local_status()['selected_id'], self.ident)

    def test_atomic_registry_failure_preserves_previous_selection(self):
        self.prepare()
        original = (self.manager.root / 'registry.json').read_bytes()
        with mock.patch.object(engines.os, 'replace', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                self.manager.activate(self.ident)
        self.assertEqual((self.manager.root / 'registry.json').read_bytes(), original)
        self.assertEqual(self.manager.local_status()['selected_id'], 'bundled')

    def test_offline_history_and_corrupt_registry_still_allow_bundled_rollback(self):
        self.prepare()
        with mock.patch.object(engines, 'remote_release', side_effect=OSError('offline')):
            status = self.manager.releases()
        self.assertEqual(len(status['releases']), 2)
        self.assertIn('offline', status['warning'])
        (self.manager.root / 'registry.json').write_text('broken')
        self.assertEqual(self.manager.local_status()['selected_id'], 'bundled')
        self.manager.prepare('bundled')
        self.manager.activate('bundled')
        self.assertIsNone(self.manager.local_status()['warning'])

    def test_cache_key_changes_when_selected_engine_changes(self):
        self.prepare()
        with mock.patch.object(server, 'enhanced_engine_manager', return_value=self.manager), mock.patch.object(server, 'get_base_dir', return_value=str(self.base)):
            a = server.info_cache_key('https://youtu.be/x', 'sabr', cfg={})
            standard = server.info_cache_key('https://example.com/x', 'standard', cfg={})
            self.manager.activate(self.ident)
            b = server.info_cache_key('https://youtu.be/x', 'sabr', cfg={})
            self.assertNotEqual(a, b)
            self.assertEqual(standard, server.info_cache_key('https://example.com/x', 'standard', cfg={}))

    def test_engine_command_uses_selected_binary_and_bundled_provider_plugins(self):
        self.prepare(); self.manager.activate(self.ident)
        runtime = self.bundled / 'node.exe'
        runtime.write_bytes(b'node')
        (self.bundled / 'server/build').mkdir()
        (self.bundled / 'server/build/main.js').write_text('fixture')
        # The fixture changed the ABI anchor; explicitly revalidate.
        with mock.patch.object(engines, 'verify_compatibility'):
            self.manager.prepare(self.ident)
        self.manager.activate(self.ident)
        with mock.patch.object(youtube_compat, 'asset_root', return_value=self.bundled), \
             mock.patch.object(engines, 'manager', return_value=self.manager), \
             mock.patch.object(youtube_compat.provider, 'start', return_value=12345):
            command = youtube_compat.command(str(runtime), str(self.base))
        self.assertEqual(command[0], str(self.manager.selected_path()))
        self.assertEqual(command[command.index('--plugin-dirs') + 1], str(self.bundled))


class EngineArchiveTests(unittest.TestCase):
    def test_zip_rejects_traversal_symlink_case_collision_and_bomb(self):
        cases = [('../evil', None), ('C:/evil', None), ('..\\evil', None), ('NUL.txt', None),
                 ('_internal/link', stat.S_IFLNK | 0o777)]
        with tempfile.TemporaryDirectory() as temporary:
            for index, (name, mode) in enumerate(cases):
                data = io.BytesIO()
                with zipfile.ZipFile(data, 'w') as bundle:
                    entry = zipfile.ZipInfo(name)
                    if mode:
                        entry.external_attr = mode << 16
                    bundle.writestr(entry, 'payload')
                with self.subTest(name=name), self.assertRaises(engines.InvalidEngine):
                    engines.safe_extract(io.BytesIO(data.getvalue()), Path(temporary) / str(index))
            for names in [('A.dll', 'a.dll'), ('huge',)]:
                data = io.BytesIO()
                with zipfile.ZipFile(data, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
                    for name in names:
                        bundle.writestr(name, b'0' * (2_000_000 if name == 'huge' else 1))
                with self.assertRaises(engines.InvalidEngine):
                    engines.safe_extract(io.BytesIO(data.getvalue()), Path(temporary) / 'invalid')

    @mock.patch.object(engines, 'engine_asset', return_value=TEST_ENGINE_ASSET)
    def test_only_exact_official_channel_asset_and_checksum_are_accepted(self, _asset):
        asset, _ = engines.engine_asset()
        payload = {'tag_name': 'sabr', 'name': 'sabr ' + VERSION, 'draft': False,
                   'assets': [{'name': asset, 'size': 1024, 'browser_download_url': engines.RELEASE_BASE + asset, 'digest': 'sha256:' + 'a'*64},
                              {'name': 'SHA2-256SUMS', 'browser_download_url': engines.RELEASE_BASE + 'SHA2-256SUMS'}]}
        def read(url, limit, target=None, proxy=None):
            self.assertEqual(proxy, 'http://127.0.0.1:8000')
            return json.dumps(payload).encode() if url == engines.API_URL else ('a'*64+'  '+asset).encode()
        with mock.patch.object(engines, 'read_url', side_effect=read):
            self.assertEqual(engines.remote_release(proxy='http://127.0.0.1:8000')['version'], VERSION)
            payload['tag_name'] = 'win315'
            with self.assertRaises(engines.EngineError):
                engines.remote_release(proxy='http://127.0.0.1:8000')
        self.assertFalse(engines._trusted_url('https://github.com/evil/repo/releases/download/sabr/yt-dlp_win.zip'))
        self.assertFalse(engines._trusted_url('http://github.com/bashonly/yt-dlp/releases/download/sabr/yt-dlp_win.zip'))
        with self.assertRaises(engines.EngineError):
            engines.TrustedRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.test/file')
        for version in ('2026.99.99.999999', '../2026.10.27.135913', '2026.10.27'):
            with self.assertRaises(engines.InvalidEngine): engines.valid_version(version)


class EnginePlatformTests(unittest.TestCase):
    def test_linux_independent_install_has_explicit_unsupported_error(self):
        with mock.patch.object(engines, 'sys', mock.Mock(platform='linux')):
            with self.assertRaisesRegex(engines.InvalidEngine, '当前平台不支持独立安装增强引擎'):
                engines.engine_asset()


class EngineApiConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.stack = __import__('contextlib').ExitStack()
        self.addCleanup(self.stack.close)
        self.gate = engines.ActivityGate()
        self.stack.enter_context(mock.patch.object(server, 'engine_activity_gate', self.gate))
        self.stack.enter_context(mock.patch.object(server, 'API_TOKEN', ''))
        self.stack.enter_context(mock.patch.object(server, 'jobs', {}))
        self.stack.enter_context(mock.patch.object(server, 'active_downloads', set()))
        self.stack.enter_context(mock.patch.object(server, 'download_queue', []))
        self.stack.enter_context(mock.patch.object(server, 'load_config', return_value={}))
        self.manager = mock.Mock()
        self.manager.activate.return_value = {'activated': True, 'selected_id': 'bundled'}
        self.stack.enter_context(mock.patch.object(server, 'enhanced_engine_manager', return_value=self.manager))

    def test_busy_download_queue_and_legacy_parse_prevent_update(self):
        client = server.app.test_client()
        for status in ('queued', 'downloading', 'paused'):
            server.jobs['job'] = {'status': status}
            self.assertEqual(client.post('/api/youtube/update', json={'id': 'bundled'}).status_code, 409)
        server.jobs.clear()
        entered, release = threading.Event(), threading.Event()
        def command(*args, **kwargs):
            entered.set(); release.wait(3); raise RuntimeError('fixture end')
        with mock.patch.object(server, 'get_extractor_command', side_effect=command):
            worker = threading.Thread(target=lambda: server.app.test_client().post('/api/info', json={'url': 'https://example.com/video'}))
            worker.start(); self.assertTrue(entered.wait(2))
            try:
                self.assertEqual(client.post('/api/youtube/update', json={'id': 'bundled'}).status_code, 409)
            finally:
                release.set(); worker.join(3)
        self.manager.prepare.assert_not_called()

    def test_new_work_during_staging_returns_409_and_never_activates(self):
        started, finish = threading.Event(), threading.Event()
        self.manager.prepare.side_effect = lambda *a, **k: (started.set(), finish.wait(3))
        responses = []
        worker = threading.Thread(target=lambda: responses.append(server.app.test_client().post('/api/youtube/update', json={'id': 'bundled'})))
        worker.start(); self.assertTrue(started.wait(2))
        # Staging does not monopolize the gate; normal work can begin.
        with self.gate.activity():
            finish.set(); worker.join(3)
            self.assertEqual(responses[0].status_code, 409)
        self.manager.prepare.assert_called_once()
        self.manager.activate.assert_not_called()

    def test_activation_rejects_new_submission_and_failure_releases_gate(self):
        def activate(ident):
            response = server.app.test_client().post('/api/download', json={'url': 'https://example.com/x'})
            self.assertEqual(response.status_code, 409)
            raise OSError('disk full')
        self.manager.activate.side_effect = activate
        response = server.app.test_client().post('/api/youtube/update', json={'id': 'bundled'})
        self.assertEqual(response.status_code, 502)
        self.assertFalse(self.gate.switching)
        with self.gate.activity(): self.assertEqual(self.gate.users, 1)

    def test_test_cookies_and_retry_are_usage_guarded(self):
        with self.gate.update(lambda: False):
            client = server.app.test_client()
            for route in ('/api/test-cookies', '/api/jobs/job/retry', '/api/local-burn', '/api/info'):
                self.assertEqual(client.post(route, json={}).status_code, 409)


if __name__ == '__main__':
    unittest.main()

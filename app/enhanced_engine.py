"""Verified, immutable SABR engine installs; the app owns the provider/plugins.

Only the upstream ``sabr`` release is a compatible remote channel. Installed
versions are retained locally; this does not pretend other experimental tags are
historical SABR releases.
"""
from contextlib import contextmanager
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import urllib.request
from urllib.parse import urlsplit
import uuid
import zipfile


API_URL = 'https://api.github.com/repos/bashonly/yt-dlp/releases/tags/sabr'
RELEASE_BASE = 'https://github.com/bashonly/yt-dlp/releases/download/sabr/'
HISTORY_NOTE = '上游只提供当前 SABR 测试版本；列表同时保留本机已安装版本和应用内置版本，可随时回退。'
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_EXPANDED = 1024 * 1024 * 1024
MAX_FILE = 256 * 1024 * 1024
MAX_FILES = 10000
VERSION_RE = re.compile(r'\d{4}\.\d{2}\.\d{2}\.\d{6}')
ID_RE = re.compile(r'sabr:(\d{4}\.\d{2}\.\d{2}\.\d{6}):([0-9a-f]{64})')


class EngineError(RuntimeError):
    pass


class InvalidEngine(ValueError):
    pass


class EngineBusy(EngineError):
    pass


class ActivityGate:
    """Atomically exclude updates from submissions/parses, including legacy API."""
    def __init__(self):
        self.lock = threading.RLock()
        self.users = 0
        self.switching = False

    @contextmanager
    def activity(self):
        with self.lock:
            if self.switching:
                raise EngineBusy('增强引擎正在更新，请稍后再试。')
            self.users += 1
        try:
            yield
        finally:
            with self.lock:
                self.users -= 1

    @contextmanager
    def update(self, busy):
        with self.lock:
            if self.switching or self.users or busy():
                raise EngineBusy('请等待解析、下载和排队任务结束后再切换增强引擎。')
            self.switching = True
        try:
            yield
        finally:
            with self.lock:
                self.switching = False


def valid_version(value):
    if not isinstance(value, str) or not VERSION_RE.fullmatch(value):
        raise InvalidEngine('无效的 SABR 版本。')
    try:
        datetime.datetime.strptime(value, '%Y.%m.%d.%H%M%S')
    except ValueError as exc:
        raise InvalidEngine('无效的 SABR 版本。') from exc
    return value


def engine_asset():
    if sys.platform == 'win32':
        return ('yt-dlp_win_arm64.zip', 'yt-dlp_arm64.exe') if platform.machine().lower() in ('arm64', 'aarch64') else ('yt-dlp_win.zip', 'yt-dlp.exe')
    if sys.platform == 'darwin':
        return 'yt-dlp_macos.zip', 'yt-dlp_macos'
    raise InvalidEngine('当前平台不支持独立安装增强引擎。')


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _reparse(path):
    info = path.lstat()
    return path.is_symlink() or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def _safe_relative(name):
    if not isinstance(name, str) or not name or '\\' in name or ':' in name or '\x00' in name:
        raise InvalidEngine('增强引擎压缩包包含不安全路径。')
    value = PurePosixPath(name)
    if value.is_absolute() or any(p in ('', '.', '..') or p.endswith((' ', '.')) for p in name.split('/')):
        raise InvalidEngine('增强引擎压缩包包含不安全路径。')
    if any(re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', p, re.I) for p in value.parts):
        raise InvalidEngine('增强引擎压缩包包含设备路径。')
    return value


def safe_extract(archive, destination):
    """Validate the complete ZIP before creating any extracted file."""
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        if len(members) > MAX_FILES:
            raise InvalidEngine('增强引擎压缩包文件过多。')
        total, seen, checked = 0, set(), []
        for member in members:
            name = member.filename.rstrip('/') if member.is_dir() else member.filename
            relative = _safe_relative(name)
            normalized = str(relative).casefold()
            if normalized in seen:
                raise InvalidEngine('增强引擎压缩包含有重复路径。')
            seen.add(normalized)
            mode = member.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or member.flag_bits & 1:
                raise InvalidEngine('增强引擎压缩包包含链接、特殊文件或加密内容。')
            total += member.file_size
            if member.file_size > MAX_FILE or total > MAX_EXPANDED or member.file_size > max(member.compress_size, 1) * 1000:
                raise InvalidEngine('增强引擎压缩包超过安全大小限制。')
            checked.append((member, relative))
        for member, relative in checked:
            target = destination.joinpath(*relative.parts)
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(member) as source, open(target, 'xb') as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
            if sys.platform != 'win32' and (member.external_attr >> 16) & 0o111:
                target.chmod(0o755)


def _trusted_url(url, *, redirect=False):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.fragment:
        return False
    if url == API_URL:
        return True
    if parsed.hostname == 'github.com' and not parsed.query:
        return parsed.path in {f'/bashonly/yt-dlp/releases/download/sabr/{name}' for name in ('SHA2-256SUMS', 'yt-dlp_win.zip', 'yt-dlp_win_arm64.zip', 'yt-dlp_macos.zip')}
    return redirect and parsed.hostname in ('release-assets.githubusercontent.com', 'objects.githubusercontent.com')


class TrustedRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _trusted_url(newurl, redirect=True):
            raise EngineError('增强引擎下载被重定向到非官方地址。')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def read_url(url, limit, target=None, proxy=None):
    if not _trusted_url(url):
        raise EngineError('增强引擎下载地址不受信任。')
    request = urllib.request.Request(url, headers={'User-Agent': 'MediaDrop', 'Accept': 'application/vnd.github+json' if url == API_URL else 'application/octet-stream'})
    handlers = [TrustedRedirect()]
    if proxy is not None:
        if proxy and urlsplit(proxy).scheme not in ('http', 'https'):
            raise EngineError('增强引擎版本下载需要 HTTP/HTTPS 代理，请在设置中选择对应代理端口。')
        handlers.append(urllib.request.ProxyHandler({'http': proxy, 'https': proxy} if proxy else {}))
    opener = urllib.request.build_opener(*handlers)
    with opener.open(request, timeout=90) as response:
        if not _trusted_url(response.url, redirect=True):
            raise EngineError('增强引擎下载地址不受信任。')
        chunks, size = [], 0
        while True:
            chunk = response.read(min(1024 * 1024, limit + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise EngineError('增强引擎下载超过大小限制。')
            if target is None:
                chunks.append(chunk)
            else:
                target.write(chunk)
        return b''.join(chunks) if target is None else size


def remote_release(proxy=None):
    asset_name, binary_name = engine_asset()
    data = json.loads(read_url(API_URL, 2 * 1024 * 1024, proxy=proxy))
    if data.get('tag_name') != 'sabr' or data.get('draft'):
        raise EngineError('上游未提供有效的 SABR 版本。')
    name = str(data.get('name', ''))
    match = re.fullmatch(r'sabr (\d{4}\.\d{2}\.\d{2}\.\d{6})', name)
    version = valid_version(match.group(1) if match else '')
    assets = {a.get('name'): a for a in data.get('assets', []) if isinstance(a, dict)}
    asset, sums = assets.get(asset_name, {}), assets.get('SHA2-256SUMS', {})
    if asset.get('browser_download_url') != RELEASE_BASE + asset_name or sums.get('browser_download_url') != RELEASE_BASE + 'SHA2-256SUMS':
        raise EngineError('上游缺少可信的安装包或校验文件。')
    size = asset.get('size')
    if not isinstance(size, int) or not 0 < size <= MAX_ARCHIVE:
        raise EngineError('上游安装包大小无效。')
    checksums = read_url(sums['browser_download_url'], 128 * 1024, proxy=proxy).decode('utf-8')
    matches = [line.split()[0].lower() for line in checksums.splitlines() if len(line.split()) == 2 and line.split()[1].lstrip('*') == asset_name]
    if len(matches) != 1 or not re.fullmatch('[0-9a-f]{64}', matches[0]):
        raise EngineError('上游未提供有效 SHA-256 校验。')
    digest = matches[0]
    if asset.get('digest') and asset['digest'] != 'sha256:' + digest:
        raise EngineError('上游校验信息不一致，请稍后重试。')
    return {'id': f'sabr:{version}:{digest}', 'version': version, 'source': 'remote',
            'installed': False, 'current': False, 'available': True,
            'published_at': data.get('published_at'), 'sha256': digest, 'size': size,
            'url': asset['browser_download_url'], 'binary': binary_name}


PROBE = '''import inspect, json
from yt_dlp.version import __version__
from yt_dlp.extractor.common import InfoExtractor
from yt_dlp.extractor.youtube import YoutubeIE
from yt_dlp.downloader.sabr import SabrFD
from yt_dlp_plugins.extractor.getpot_bgutil_http import BgUtilHTTPPTP
from yt_dlp_plugins.extractor.mediadrop_player import YoutubeMediaDropPlayerIE
assert issubclass(YoutubeMediaDropPlayerIE, YoutubeIE)
assert list(inspect.signature(YoutubeIE._load_player).parameters) == ['self', 'video_id', 'player_url', 'fatal']
assert callable(YoutubeIE._player_js_cache_key)
ie = YoutubeIE()
assert isinstance(ie._code_cache, dict) and isinstance(ie._player_cache, dict)
assert hasattr(SabrFD, 'real_download') and hasattr(BgUtilHTTPPTP, '_real_request_pot')
print('MEDIADROP_ENGINE_COMPAT ' + json.dumps({'version': __version__}))
class MediaDropCompatProbeIE(InfoExtractor):
    _VALID_URL = r'mediadrop-compat:(?P<id>offline)'
    def _real_extract(self, url):
        return {'id': 'offline', 'title': 'compatibility probe', 'url': 'https://invalid.example/probe.mp4'}
'''


def verify_compatibility(binary, version, bundled_root, workdir):
    """Offline native probe imports the actual packaged engine and our plugins."""
    probe = workdir / 'compat-probe' / 'probe' / 'yt_dlp_plugins' / 'extractor'
    probe.mkdir(parents=True, exist_ok=True)
    (probe / 'mediadrop_compat_probe.py').write_text(PROBE, encoding='utf-8')
    env = os.environ.copy()
    env.pop('PYTHONPATH', None)
    env.pop('MEDIADROP_PLAYER_CACHE_TOKEN', None)
    env.pop('MEDIADROP_PLAYER_CACHE_URL', None)
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    command = [str(binary), '--ignore-config', '--no-update', '--no-cache-dir',
               '--no-plugin-dirs', '--plugin-dirs', str(bundled_root),
               '--plugin-dirs', str(probe.parents[2]), '--verbose', '--simulate',
               '--skip-download', 'mediadrop-compat:offline']
    result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace',
                            timeout=45, env=env, cwd=workdir,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    markers = re.findall(r'^MEDIADROP_ENGINE_COMPAT (.+)$', result.stdout, re.M)
    if result.returncode or not markers or any(json.loads(marker).get('version') != version for marker in markers) or 'Error loading plugin' in result.stderr:
        raise EngineError('该 SABR 版本与应用的字幕、缓存或 PO Token 插件不兼容，已保留原版本。')


class EngineManager:
    def __init__(self, data_dir, bundled_root):
        self.root = Path(data_dir) / 'tools' / 'youtube-engines'
        self.bundled_root = Path(bundled_root)
        self.lock = threading.RLock()
        self.install_lock = threading.Lock()
        self._verified = {}

    @property
    def bundled_binary(self):
        return self.bundled_root / ('yt-dlp-sabr.exe' if sys.platform == 'win32' else 'yt-dlp-sabr')

    def _ensure_root(self):
        if self.root.parent.exists() and _reparse(self.root.parent):
            raise EngineError('增强引擎保存目录不能是链接。')
        if self.root.exists() and _reparse(self.root):
            raise EngineError('增强引擎保存目录不能是链接。')
        self.root.mkdir(parents=True, exist_ok=True)

    def _registry(self):
        path = self.root / 'registry.json'
        if not path.exists():
            return {'selected': 'bundled', 'installed': {}}
        if _reparse(self.root) or _reparse(self.root.parent):
            raise EngineError('增强引擎保存目录不能是链接。')
        if _reparse(path) or path.stat().st_size > 8 * 1024 * 1024:
            raise EngineError('增强引擎版本记录损坏。')
        data = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(data, dict) or not isinstance(data.get('installed'), dict) or len(data['installed']) > 100 or not isinstance(data.get('selected'), str):
            raise EngineError('增强引擎版本记录损坏。')
        return data

    def _save(self, data):
        self._ensure_root()
        temporary = self.root / f'.registry-{uuid.uuid4().hex}.tmp'
        try:
            with open(temporary, 'x', encoding='utf-8') as stream:
                json.dump(data, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.root / 'registry.json')
        finally:
            temporary.unlink(missing_ok=True)

    def _directory(self, ident):
        match = ID_RE.fullmatch(ident) if isinstance(ident, str) else None
        if not match:
            raise InvalidEngine('无效的增强引擎选择。')
        valid_version(match.group(1))
        # Keep dependency DLL paths below legacy Windows MAX_PATH in ordinary
        # user profiles. The public ID/registry retain the full SHA-256; an
        # existing directory is never overwritten, including a prefix collision.
        return self.root / match.group(2)[:24]

    def _valid_install(self, ident, metadata):
        try:
            match = ID_RE.fullmatch(ident)
            if not isinstance(metadata, dict) or not match or metadata.get('version') != match.group(1) or metadata.get('sha256') != match.group(2) or metadata.get('binary') != engine_asset()[1]:
                return False
            directory = self._directory(ident)
            if not directory.is_dir() or _reparse(directory) or _reparse(self.root) or _reparse(self.root.parent):
                return False
            binary = metadata['binary']
            _safe_relative(binary)
            expected = metadata['files']
            if not isinstance(expected, dict) or not expected or len(expected) > MAX_FILES or binary not in expected:
                return False
            stamps = []
            actual = {}
            for file in directory.rglob('*'):
                if _reparse(file):
                    return False
                if file.is_file():
                    relative = file.relative_to(directory).as_posix()
                    info = file.stat()
                    actual[relative] = file
                    stamps.append((relative, info.st_size, info.st_mtime_ns, info.st_ctime_ns))
            fingerprint = (tuple(sorted(stamps)), tuple(sorted(expected.items())))
            if set(actual) != set(expected):
                return False
            if self._verified.get(ident) != fingerprint:
                if any(not re.fullmatch('[0-9a-f]{64}', checksum) or sha256(actual[name]) != checksum for name, checksum in expected.items()):
                    return False
                self._verified[ident] = fingerprint
            return True
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def compatibility_fingerprint(self):
        """Provider, dependency lock and both plugin sources form the ABI anchor."""
        digest = hashlib.sha256()
        files = [self.bundled_root / 'server/package.json',
                 self.bundled_root / 'server/node_modules/.package-lock.json']
        for relative in ('server/build', 'plugin/yt_dlp_plugins', 'mediadrop/yt_dlp_plugins'):
            directory = self.bundled_root / relative
            if directory.is_dir():
                files.extend(p for p in directory.rglob('*') if p.is_file() and p.suffix in ('.js', '.py'))
        for file in sorted(files):
            digest.update(file.relative_to(self.bundled_root).as_posix().encode())
            digest.update(file.read_bytes() if file.is_file() else b'<missing>')
        return digest.hexdigest()

    def local_status(self):
        with self.lock:
            warning = None
            try:
                registry = self._registry()
            except (OSError, ValueError, EngineError):
                registry = {'selected': 'bundled', 'installed': {}}
                warning = '增强引擎版本记录损坏，已回退到应用内置版本。'
            try:
                manifest = json.loads((self.bundled_root / 'manifest.json').read_text(encoding='utf-8-sig'))
            except (OSError, ValueError):
                manifest = {}
            bundled_version = manifest.get('engine_version')
            available = self.bundled_binary.is_file()
            effective = registry['selected']
            anchor = self.compatibility_fingerprint()
            rows = [{'id': 'bundled', 'version': bundled_version, 'source': 'bundled', 'installed': True,
                     'available': available, 'published_at': None}]
            for ident, metadata in registry['installed'].items():
                if not isinstance(metadata, dict) or not ID_RE.fullmatch(ident):
                    continue
                valid = self._valid_install(ident, metadata)
                rows.append({'id': ident, 'version': metadata.get('version'), 'source': 'installed',
                             'installed': True, 'available': valid, 'published_at': metadata.get('published_at'),
                             'needs_validation': valid and metadata.get('compatibility') != anchor})
            selected = next((row for row in rows if row['id'] == effective and row['available'] and not row.get('needs_validation')), None)
            if selected is None:
                if effective != 'bundled':
                    warning = '所选增强引擎缺失、校验失败或需适配当前应用，已回退内置版本；可重新选择本机版本以验证兼容性。'
                selected, effective = rows[0], 'bundled'
            for row in rows:
                row['current'] = row['id'] == effective
            return {'current': selected['version'], 'bundled': bundled_version, 'selected_id': effective,
                    'provider_version': manifest.get('provider'), 'available': selected['available'],
                    'releases': rows, 'history_note': HISTORY_NOTE, 'warning': warning}

    def selected_path(self):
        with self.lock:
            status = self.local_status()
            ident = status['selected_id']
            if ident == 'bundled':
                return self.bundled_binary
            metadata = self._registry()['installed'][ident]
            return self._directory(ident) / metadata['binary']

    def fingerprint(self):
        path = self.selected_path()
        try:
            info = path.stat()
            return str(path), info.st_size, info.st_mtime_ns, info.st_ctime_ns
        except OSError:
            return str(path), None

    def releases(self, proxy=None):
        status = self.local_status()
        try:
            remote = remote_release(proxy=proxy)
            if not any(row['id'] == remote['id'] for row in status['releases']):
                status['releases'].append({key: remote[key] for key in ('id', 'version', 'source', 'installed', 'current', 'available', 'published_at')})
        except Exception as exc:
            status['warning'] = '；'.join(filter(None, (status['warning'], '无法检查上游版本，仍可切换本机版本：' + str(exc))))
        return status

    def prepare(self, ident, proxy=None):
        """Download/probe without blocking normal use; do not change selection."""
        if not isinstance(ident, str):
            raise InvalidEngine('无效的增强引擎选择。')
        if ident == 'bundled':
            if not self.bundled_binary.is_file():
                raise InvalidEngine('应用内置增强引擎缺失，请重新安装应用。')
            return
        self._directory(ident)
        if not self.install_lock.acquire(blocking=False):
            raise EngineBusy('增强引擎正在下载或验证，请稍后再试。')
        try:
            with self.lock:
                registry = self._registry()
                metadata = registry['installed'].get(ident)
                if metadata is not None and not self._valid_install(ident, metadata):
                    raise InvalidEngine('本机增强引擎校验失败，不能切换。')
                self._ensure_root()
            if metadata is not None:
                # Recheck against this app/provider after an application upgrade.
                with tempfile.TemporaryDirectory(prefix='.probe-', dir=self.root) as scratch:
                    verify_compatibility(self._directory(ident) / metadata['binary'], metadata['version'], self.bundled_root, Path(scratch))
                with self.lock:
                    registry = self._registry()
                    anchor = self.compatibility_fingerprint()
                    if registry['selected'] == ident and registry['installed'][ident].get('compatibility') != anchor:
                        # The effective engine is already bundled because the
                        # anchor changed. Preparation must not reactivate it.
                        registry['selected'] = 'bundled'
                    registry['installed'][ident]['compatibility'] = anchor
                    self._save(registry)
                return
            release = remote_release(proxy=proxy)
            if release['id'] != ident:
                raise InvalidEngine('上游 SABR 版本已变化，请刷新版本列表后重试。')
            destination = self._directory(ident)
            if destination.exists():
                raise InvalidEngine('该版本目录已存在但未通过登记，请使用内置版本。')
            with tempfile.TemporaryDirectory(prefix='.install-', dir=self.root) as scratch:
                scratch = Path(scratch)
                archive = scratch / 'engine.zip'
                with open(archive, 'xb') as stream:
                    count = read_url(release['url'], MAX_ARCHIVE, stream, proxy=proxy)
                if count != release['size'] or sha256(archive) != release['sha256']:
                    raise EngineError('增强引擎 SHA-256 校验失败，已保留原版本。')
                unpacked = scratch / 'engine'
                unpacked.mkdir()
                safe_extract(archive, unpacked)
                binary = unpacked / release['binary']
                if not binary.is_file() or not (unpacked / '_internal').is_dir():
                    raise EngineError('增强引擎压缩包不是完整的独立运行目录。')
                if sys.platform != 'win32':
                    binary.chmod(0o755)
                verify_compatibility(binary, release['version'], self.bundled_root, scratch)
                metadata = {key: release[key] for key in ('version', 'published_at', 'binary', 'sha256')}
                metadata['compatibility'] = self.compatibility_fingerprint()
                metadata['files'] = {p.relative_to(unpacked).as_posix(): sha256(p) for p in unpacked.rglob('*') if p.is_file()}
                with self.lock:
                    registry = self._registry()
                    os.replace(unpacked, destination)
                    registry['installed'][ident] = metadata
                    try:
                        self._save(registry)
                        self._valid_install(ident, metadata)
                    except Exception:
                        # This is the fresh, unregistered directory created above.
                        if destination.parent.resolve() == self.root.resolve() and not _reparse(destination):
                            shutil.rmtree(destination)
                        raise
        finally:
            self.install_lock.release()

    def activate(self, ident):
        """Brief atomic selection only; caller owns ActivityGate.update."""
        with self.lock:
            try:
                registry = self._registry()
            except (OSError, ValueError, EngineError):
                if ident != 'bundled':
                    raise
                registry = {'selected': 'bundled', 'installed': {}}
            if ident == 'bundled':
                if not self.bundled_binary.is_file():
                    raise InvalidEngine('应用内置增强引擎缺失，请重新安装应用。')
            elif ident not in registry['installed'] or not self._valid_install(ident, registry['installed'][ident]) or registry['installed'][ident].get('compatibility') != self.compatibility_fingerprint():
                raise InvalidEngine('本机增强引擎校验失败，不能切换。')
            registry['selected'] = ident
            self._save(registry)
            status = self.local_status()
            status['activated'] = True
            return status


_managers = {}
_manager_lock = threading.Lock()


def manager(data_dir, bundled_root):
    key = (os.path.abspath(data_dir), os.path.abspath(bundled_root))
    with _manager_lock:
        if key not in _managers:
            _managers[key] = EngineManager(*key)
        return _managers[key]

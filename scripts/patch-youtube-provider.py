"""Make upstream provider usable with Electron's bundled Node and port zero."""
import hashlib
import json
import pathlib
import subprocess
import sys
root = pathlib.Path(sys.argv[1])
p = root / 'server/build/main.js'
s = p.read_text()
for old, new in [('.parse();', '.parse(process.argv, { from: "node" });'),
                 ('server.removeListener("error", reject);', 'server.removeListener("error", reject);\n        console.log(`MEDIADROP_POT_READY ${server.address().port}`);')]:
    if new not in s:
        if old not in s:
            raise SystemExit('Provider source changed; review the integration patch')
        s = s.replace(old, new, 1)
p.write_text(s)
binary = root / ('yt-dlp-sabr.exe' if (root / 'yt-dlp-sabr.exe').exists() else 'yt-dlp-sabr')
engine_version = subprocess.check_output([str(binary.resolve()), '--version'], text=True, timeout=30).strip()
if engine_version != '2026.10.27.135913':
    raise SystemExit(f'Unexpected enhanced engine version: {engine_version}')
(root / 'manifest.json').write_text(json.dumps({
    'engine': 'sabr', 'engine_version': engine_version,
    'engine_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
    'provider': '2.0.2', 'sources': ['https://github.com/bashonly/yt-dlp/releases/tag/sabr',
                                 'https://github.com/Brainicism/bgutil-ytdlp-pot-provider/tree/2.0.2'],
    'modifications': 'Electron Node argument parsing; ephemeral loopback port readiness marker',
}, indent=2))

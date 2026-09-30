"""Narrow public YouTube player-script cache policy, shared with the engine plugin."""
import re
from urllib.parse import urlsplit

MAX_SCRIPT_BYTES = 8 * 1024 * 1024


def allowed_player_url(url):
    if not isinstance(url, str) or len(url) > 512 or any(ord(c) < 33 for c in url):
        return False
    try:
        parsed = urlsplit(url)
        return (parsed.scheme == 'https' and parsed.netloc == 'www.youtube.com'
                and not parsed.query and not parsed.fragment
                and '..' not in parsed.path and '%' not in parsed.path
                and bool(re.fullmatch(r'/s/player/[a-fA-F0-9]{8,64}/[A-Za-z0-9_./-]{1,180}\.js', parsed.path)))
    except ValueError:
        return False

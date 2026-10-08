#!/usr/bin/env python3
"""recall: a local search engine over past coding-agent sessions.

Indexes Claude Code transcripts (and their subagents), Codex CLI sessions, Claude memory files,
standing orders, second-opinion reviews and notes into one SQLite FTS5 database, and answers
searches with JSON. Standard library only, Python 3.9+.

Every command prints one JSON object on stdout. On error it prints {"error": "..."} and exits 1.
CONTRACT.md documents the commands and the JSON they return.
"""
from __future__ import annotations

import argparse
import errno
import fcntl
import heapq
import json
import os
import re
import sqlite3
import sys
import time

SCHEMA_VERSION = 2   # 2: docs.flags, files.fmt (v1 databases are migrated in place)
INDEX_FORMAT = 2     # bump when extraction changes: files indexed by an older format are re-read once
FLAG_INSPECT = 1     # docs.flags bit: a read-only inspection command

KIND_WEIGHTS = {
    'note': 3.0, 'decision': 2.5, 'summary': 2.0, 'title': 2.0, 'memory': 2.0, 'order': 2.0,
    'pr': 1.8, 'commit': 1.8, 'issue': 1.8, 'prompt': 1.5, 'command': 1.2, 'review': 1.2,
    'answer': 1.0, 'file': 1.0, 'url': 0.8, 'task': 0.8,
}
ALL_KINDS = tuple(KIND_WEIGHTS)
EXPAND_KINDS = ('prompt', 'answer', 'summary', 'decision', 'command')
SOURCES = ('claude', 'codex', 'memory', 'orders', 'reviews')

CHUNK_CHARS = 1500          # target size of one indexed chunk
MAX_OUTPUT = 200_000        # no command prints more than this many characters
BIG_LINE = 256 * 1024       # lines above this get their base64 payloads stripped before parsing
HUGE_LINE = 8 * 1024 * 1024  # lines still above this after stripping are skipped
SUB_WEIGHT = 0.6            # subagent docs (their final report keeps 1.0)
INSPECT_WEIGHT = 0.3        # read-only inspection commands (ls, grep, git status...)
ROUTINE_WEIGHT = 0.5
NOTIFICATION_WEIGHT = 0.5
BOOST_WEIGHT = 1.5
DAY_MS = 86_400_000


class RecallError(Exception):
    """An error reported to the caller as {"error": ...}."""


class _Lazy:
    """A regex compiled on first use: most patterns are only needed when indexing, and compiling them
    all would slow down every search's start-up."""
    __slots__ = ('_args', '_rx')

    def __init__(self, pattern, flags=0):
        self._args = (pattern, flags)
        self._rx = None

    def __getattr__(self, name):
        rx = self._rx
        if rx is None:
            rx = self._rx = re.compile(*self._args)
        return getattr(rx, name)


def _timegm(y: int, mo: int, d: int, h: int = 0, mi: int = 0, s: int = 0) -> int:
    """calendar.timegm without importing calendar (days-from-civil)."""
    y -= mo <= 2
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (mo + (-3 if mo > 2 else 9)) + 2) // 5 + d - 1
    days = era * 146097 + yoe * 365 + yoe // 4 - yoe // 100 + doy - 719468
    return days * 86400 + h * 3600 + mi * 60 + s


# --------------------------------------------------------------------------------------------
# Small helpers

def now_ms() -> int:
    return int(time.time() * 1000)


_HOUR_CACHE = {}


def ts_ms(value) -> int | None:
    """Epoch milliseconds from an ISO-8601 string or an epoch number (seconds or ms)."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value * 1000) if value < 1e11 else int(value)
    if not isinstance(value, str):
        return None
    s = value.strip()
    if len(s) == 24 and s[19] == '.' and s[23] == 'Z' and s[10] == 'T':   # 2026-10-05T07:09:08.039Z
        base = _HOUR_CACHE.get(s[:13])
        if base is not None:
            try:
                return (base + int(s[14:16]) * 60 + int(s[17:19])) * 1000 + int(s[20:23])
            except ValueError:
                pass
    if len(s) >= 19 and s[4] == '-' and s[7] == '-' and s[10] in 'Tt ':
        try:
            base = _HOUR_CACHE.get(s[:13])
            if base is None:
                base = _timegm(int(s[0:4]), int(s[5:7]), int(s[8:10]), int(s[11:13]))
                if len(_HOUR_CACHE) > 20000:
                    _HOUR_CACHE.clear()
                _HOUR_CACHE[s[:13]] = base
            secs = base + int(s[14:16]) * 60 + int(s[17:19])
            rest = s[19:]
            frac = 0
            if rest.startswith('.'):
                j = 1
                while j < len(rest) and rest[j].isdigit():
                    j += 1
                frac = int((rest[1:j] + '000')[:3])
                rest = rest[j:]
            if rest and rest[0] in '+-':
                tz = rest[1:].replace(':', '')
                off = int(tz[0:2]) * 3600 + int(tz[2:4] or 0) * 60
                secs -= off if rest[0] == '+' else -off
            return secs * 1000 + frac
        except (ValueError, IndexError):
            pass
    import datetime
    try:
        return int(datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000)
    except ValueError:
        return None


def clip(text: str, limit: int) -> str:
    if text is None:
        return ''
    if len(text) <= limit:
        return text
    return text[:max(0, limit - 1)].rstrip() + '…'


def one_line(text: str, limit: int = 0) -> str:
    out = re.sub(r'\s+', ' ', text or '').strip()
    return clip(out, limit) if limit else out


def project_name(key: str | None) -> str | None:
    if not key:
        return None
    base = key.rstrip('/').rsplit('/', 1)[-1]
    return base or key


def sha(text: str, n: int = 16) -> str:
    import hashlib
    return hashlib.sha1(text.encode('utf-8', 'replace')).hexdigest()[:n]


def sha_bytes(data: bytes) -> str:
    import hashlib
    return hashlib.sha1(data).hexdigest()


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


def loads(text, default=None):
    if not text:
        return default
    try:
        return json.loads(text)
    except ValueError:
        return default


def local_date(ms: int) -> str:
    return time.strftime('%Y-%m-%d', time.localtime(ms / 1000))


def parse_time(value: str, end: bool = False) -> int:
    """`7d`, `12h`, `2w`, `3m`, `1y`, `today`, `yesterday`, `YYYY-MM-DD`, ISO time or epoch ms.

    A bare date as an `until` bound (end=True) means the end of that day."""
    s = (value or '').strip()
    low = s.lower()
    if not s:
        raise RecallError('empty time value')
    m = re.fullmatch(r'(\d+(?:\.\d+)?)\s*(h|d|w|m|y)', low)
    if m:
        unit = {'h': 3_600_000, 'd': DAY_MS, 'w': 7 * DAY_MS, 'm': 30 * DAY_MS, 'y': 365 * DAY_MS}[m.group(2)]
        return now_ms() - int(float(m.group(1)) * unit)
    if low in ('today', 'yesterday'):
        t = time.localtime()
        midnight = int(time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1)) * 1000)
        start = midnight - (DAY_MS if low == 'yesterday' else 0)
        return start + DAY_MS if end else start
    m = re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})', s)
    if m:
        start = int(time.mktime((int(m.group(1)), int(m.group(2)), int(m.group(3)), 0, 0, 0, 0, 0, -1)) * 1000)
        return start + DAY_MS if end else start
    if re.fullmatch(r'\d{9,13}', s):
        return ts_ms(int(s))
    t = ts_ms(s)
    if t is None:
        raise RecallError('cannot read time %r (use 7d, 12h, YYYY-MM-DD or an ISO time)' % value)
    return t


# --------------------------------------------------------------------------------------------
# Secret masking: applied to every text before it is stored

def _mask(value: str) -> str:
    return '[secret …%s]' % value[-4:]


_SHAPE_RE = _Lazy(
    r'(?<![A-Za-z0-9])(?:'
    r'(?:AKIA|ASIA)[0-9A-Z]{16}'
    r'|gh[pousr]_[A-Za-z0-9]{36,255}'
    r'|github_pat_[A-Za-z0-9_]{22,255}'
    r'|sk-ant-[A-Za-z0-9_\-]{20,}'
    r'|sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\-]{32,}'
    r'|xox[abprs]-[A-Za-z0-9\-]{10,}'
    r'|AIza[0-9A-Za-z_\-]{35}'
    r'|hf_[A-Za-z0-9]{30,}'
    r'|glpat-[A-Za-z0-9_\-]{20,}'
    r'|npm_[A-Za-z0-9]{36}'
    r'|(?:sk|rk)_live_[A-Za-z0-9]{16,}'
    r')(?![A-Za-z0-9])')
_AWS_ID_RE = _Lazy(r'(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])')
_AWS_SECRET_RE = _Lazy(r'(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])')
_PEM_RE = _Lazy(r'-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----([\s\S]*?)(?:-----END[A-Z0-9 ]*PRIVATE KEY-----|\Z)')
_BEARER_RE = _Lazy(r'(?i)\b(bearer)(\s+)([A-Za-z0-9\-._~+/]{16,}=*)')
_URL_CRED_RE = _Lazy(r'\b([A-Za-z][A-Za-z0-9+.\-]{1,20}://)([^\s/:@\'"<>]+):([^\s/@\'"<>]+)@')
_LABEL = (r'(?:wi-?fi[ _-]?password|password|passwd|passphrase|pass[ _-]?word|client[ _-]?secret'
          r'|secret[ _-]?access[ _-]?key|secret[ _-]?key|access[ _-]?key[ _-]?id|access[ _-]?key'
          r'|api[ _-]?key|apikey|auth[ _-]?token|access[ _-]?token|refresh[ _-]?token|private[ _-]?key'
          r'|secret|token)')
_LABELLED_RE = _Lazy(
    r'(?i)(' + _LABEL + r')(?![A-Za-z0-9])'
    r'(["\']?)'
    r'(\s*(?::=|=>|:|=)\s*|\s+(?:is|are|was)\s+|[ \t]*:?[ \t]*\r?\n[ \t]*)'
    r'(["\'`]?)'
    r'([^\s"\'`,;)}\]]{8,})')
_LABEL_KEYWORDS = ('pass', 'secret', 'token', 'key')
_SHAPE_HINTS = ('AKIA', 'ASIA', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'sk-', 'xox', 'AIza',
                'hf_', 'glpat-', 'npm_', '_live_')
_ASCII_ALNUM = frozenset('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
_PLACEHOLDER_WORDS = {
    'password', 'passwords', 'placeholder', 'changeme', 'redacted', 'example', 'required', 'optional',
    'undefined', 'null', 'none', 'true', 'false', 'string', 'secret', 'secrets', 'token', 'tokens',
    'notset', 'unset', 'missing', 'invalid', 'incorrect', 'correct', 'expired', 'revoked', 'generated',
    'stored', 'created', 'configured', 'available', 'provided', 'present', 'different', 'unchanged',
    'rotated', 'updated', 'needed', 'necessary', 'sensitive', 'visible', 'hidden', 'encrypted',
    'hashed', 'included', 'embedded', 'exposed', 'leaked', 'printed', 'logged', 'already',
    'currently', 'probably', 'actually', 'definitely', 'something', 'anything', 'whatever',
    'enabled', 'disabled', 'supported', 'accepted', 'rejected', 'specified', 'returned',
}
_REF_PREFIXES = ('os.environ', 'process.env', 'getenv', 'environ[', 'env.', 'env[', 'secrets.',
                 'self.', 'this.', 'config.', 'settings.', 'options.', 'opts.', 'args.', 'params.')


def _is_placeholder(value: str) -> bool:
    v = value.strip()
    if not v or v[0] in '$%{<[@#&*' or v.startswith('\\$'):
        return True
    low = v.lower()
    if low in _PLACEHOLDER_WORDS or low.rstrip('.') in _PLACEHOLDER_WORDS:
        return True
    if low.startswith(_REF_PREFIXES) or low.startswith(('your', '<your', 'my_', 'my-')):
        return True
    if 'example' in low or 'placeholder' in low or low.endswith('_here') or low.endswith('-here'):
        return True
    if re.fullmatch(r'[*xX.•_\-]+', v):
        return True
    if re.match(r'[A-Za-z_][\w.]*\(', v):          # a function call
        return True
    if re.fullmatch(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+', v):   # a dotted identifier
        return True
    return False


def mask_secrets(text: str) -> str:
    if not text:
        return text
    if _REDACT['literals']:
        text = _redact_literals(text)
    if 'AKIA' in text or 'ASIA' in text:
        windows = [(m.start() - 300, m.end() + 300) for m in _AWS_ID_RE.finditer(text)]
        if windows:
            def aws(m):
                if any(a <= m.start() <= b for a, b in windows):
                    return _mask(m.group(0))
                return m.group(0)
            text = _AWS_SECRET_RE.sub(aws, text)
    if 'PRIVATE KEY' in text:
        text = _PEM_RE.sub(lambda m: _mask(re.sub(r'[^A-Za-z0-9+/=]', '', m.group(1)) or 'pem!'), text)
    if any(h in text for h in _SHAPE_HINTS):
        text = _SHAPE_RE.sub(lambda m: _mask(m.group(0)), text)
    if '://' in text and '@' in text:
        def url(m):
            if _is_placeholder(m.group(3)):
                return m.group(0)
            return m.group(1) + m.group(2) + ':' + _mask(m.group(3)) + '@'
        text = _URL_CRED_RE.sub(url, text)
    low = _lower_same_length(text)
    if 'bearer' in low:
        text = _BEARER_RE.sub(lambda m: m.group(1) + m.group(2) + _mask(m.group(3)), text)
        low = _lower_same_length(text)
    return _mask_labelled(text, low)


def _lower_same_length(text: str) -> str:
    """text.lower() with the same indices as text (a few characters, like 'İ', lowercase to two)."""
    low = text.lower()
    if len(low) == len(text):
        return low
    return text.encode('ascii', 'replace').decode('ascii').lower()


def _mask_labelled(text: str, low: str) -> str:
    """Masks `label: value` pairs. The labels are found with str.find (fast) and the full pattern is
    only tried at word starts just before each one, instead of scanning the text with the regex."""
    found = {}
    for kw in _LABEL_KEYWORDS:
        p = low.find(kw)
        while p >= 0:
            for s in range(max(0, p - 18), p + 1):
                if s in found:
                    break
                if s > 0 and text[s - 1] in _ASCII_ALNUM:
                    continue
                m = _LABELLED_RE.match(text, s)
                if m:
                    found[s] = m
                    break
            p = low.find(kw, p + 1)
    if not found:
        return text
    out, last = [], 0
    for s in sorted(found):
        m = found[s]
        if s < last:
            continue
        value = m.group(5)
        if _is_placeholder(value) or value.startswith('[secret'):
            continue
        out.append(text[last:m.start(5)])
        out.append(_mask(value))
        last = m.end(5)
    out.append(text[last:])
    return ''.join(out)


def mask_obj(obj):
    if isinstance(obj, str):
        return mask_secrets(obj)
    if isinstance(obj, dict):
        return {k: mask_obj(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [mask_obj(v) for v in obj]
    return obj


# --------------------------------------------------------------------------------------------
# Literal redaction: exact strings the user marks as secret. Their values are never printed and
# never stored; the database keeps only a salted, slow hash of the set to notice changes.

REDACT_MIN_CHARS = 6
EXPORT_MIN_CHARS = 8
REDACT_KDF_ROUNDS = 200_000
RC_FILES = ('.zshrc', '.zprofile', '.bashrc', '.bash_profile')
_EXPORT_RE = _Lazy(r'^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$')
_SECRET_NAME_RE = _Lazy(r'KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PWD|CREDENTIAL|AUTH|PRIVATE', re.I)
_URL_PARTS_RE = _Lazy(r'^[A-Za-z][A-Za-z0-9+.\-]*://([^/?#]*)[^?#]*(?:\?([^#]*))?')
_SECRET_PARAM_RE = _Lazy(r'(?:^|[&;])[^=&;]*(?:key|token|secret|pass|sig|auth|credential)[^=&;]*=', re.I)
_REDACT = {'literals': (), 'rx': None}


def redact_paths(home: str) -> list:
    return [os.path.join(home, '.claude', 'recall', 'redact.txt')] + [os.path.join(home, f) for f in RC_FILES]


def _read_lines(path: str, limit: int = 4 * 1024 * 1024) -> list:
    try:
        with open(path, 'rb') as fh:
            return fh.read(limit).decode('utf-8', 'replace').splitlines()
    except OSError:
        return []


def shell_export_value(rhs: str):
    """The literal value of `export NAME=<rhs>` (simple quoting), or None for expansions and blanks."""
    v = rhs.strip()
    if not v:
        return None
    if v[0] == "'":
        end = v.find("'", 1)
        return v[1:end] if end > 0 else None
    if v[0] == '"':
        out, i = [], 1
        while i < len(v):
            c = v[i]
            if c == '\\' and i + 1 < len(v) and v[i + 1] in '"\\$`':
                out.append(v[i + 1])
                i += 2
                continue
            if c == '"':
                return ''.join(out)
            if c in '$`':
                return None  # an expansion, not a literal
            out.append(c)
            i += 1
        return None
    out, i = [], 0
    while i < len(v):
        c = v[i]
        if c == '\\' and i + 1 < len(v):
            out.append(v[i + 1])
            i += 2
            continue
        if c.isspace() or c == ';':
            break
        if c in '$`\'"':
            return None
        out.append(c)
        i += 1
    return ''.join(out) or None


def _export_worthy(value: str) -> bool:
    if len(value) < EXPORT_MIN_CHARS or value[0] in '$/~':
        return False
    m = _URL_PARTS_RE.match(value)
    if m:  # a URL counts only when it carries credentials
        return '@' in (m.group(1) or '') or bool(_SECRET_PARAM_RE.search(m.group(2) or ''))
    return True


def load_literals(home: str) -> list:
    """The literal redaction set: redact.txt lines and secret-named shell exports, longest first."""
    lits = set()
    for line in _read_lines(os.path.join(home, '.claude', 'recall', 'redact.txt')):
        s = line.strip()
        if s and not s.startswith('#') and len(s) >= REDACT_MIN_CHARS:
            lits.add(s)
    for name in RC_FILES:
        for line in _read_lines(os.path.join(home, name)):
            if 'export' not in line:
                continue
            m = _EXPORT_RE.match(line)
            if not m or not _SECRET_NAME_RE.search(m.group(1)):
                continue
            value = shell_export_value(m.group(2))
            if value and _export_worthy(value):
                lits.add(value)
    return sorted(lits, key=lambda s: (-len(s), s))


def set_redaction(literals) -> None:
    lits = tuple(literals)
    _REDACT['literals'] = lits
    _REDACT['rx'] = re.compile('|'.join(re.escape(x) for x in lits)) if lits else None


def _redact_literals(text: str) -> str:
    for lit in _REDACT['literals']:
        if lit in text:
            return _REDACT['rx'].sub(lambda m: _mask(m.group(0)), text)
    return text


def _literal_digest(literals, salt: bytes, rounds: int) -> str:
    import hashlib
    return hashlib.pbkdf2_hmac('sha256', '\n'.join(sorted(literals)).encode('utf-8'), salt, rounds).hex()


def _literals_match(stored: str, literals) -> bool:
    import hmac
    try:
        kind, rounds, salt, digest = stored.split('$')
        if kind != 'pbkdf2-sha256':
            return False
        return hmac.compare_digest(_literal_digest(literals, bytes.fromhex(salt), int(rounds)), digest)
    except (ValueError, TypeError):
        return False


def _new_literal_hash(literals) -> str:
    salt = os.urandom(16)
    return 'pbkdf2-sha256$%d$%s$%s' % (REDACT_KDF_ROUNDS, salt.hex(), _literal_digest(literals, salt, REDACT_KDF_ROUNDS))


def _redact_signature(home: str) -> str:
    sig = []
    for p in redact_paths(home):
        try:
            st = os.stat(p)
            sig.append([p, st.st_size, st.st_mtime_ns])
        except OSError:
            sig.append([p, None, None])
    return json.dumps(sig)


# --------------------------------------------------------------------------------------------
# Text shaping

def chunk_text(text: str, size: int = CHUNK_CHARS) -> list:
    """Splits long text into ~size-character chunks on paragraph, then line, then word boundaries."""
    text = text.strip()
    if len(text) <= size:
        return [text] if text else []
    chunks, cur = [], ''

    def pieces_of(par):
        if len(par) <= size:
            return [par]
        out, acc = [], ''
        for line in par.split('\n'):
            while len(line) > size:
                cut = line.rfind(' ', size // 2, size)
                cut = cut if cut > 0 else size
                if acc:
                    out.append(acc)
                    acc = ''
                out.append(line[:cut])
                line = line[cut:].lstrip()
            if acc and len(acc) + 1 + len(line) > size:
                out.append(acc)
                acc = line
            else:
                acc = acc + '\n' + line if acc else line
        if acc:
            out.append(acc)
        return out

    for par in re.split(r'\n[ \t]*\n', text):
        par = par.strip()
        if not par:
            continue
        for piece in pieces_of(par):
            if cur and len(cur) + 2 + len(piece) > size:
                chunks.append(cur)
                cur = piece
            else:
                cur = cur + '\n\n' + piece if cur else piece
    if cur:
        chunks.append(cur)
    chunks = [c for c in (c.strip() for c in chunks) if c]
    # fold slivers (a one-line lead-in, a short tail) into their neighbour
    merged = []
    for c in chunks:
        if merged and (len(c) < 200 or len(merged[-1]) < 200) and len(merged[-1]) + 2 + len(c) <= size + 300:
            merged[-1] = merged[-1] + '\n\n' + c
        else:
            merged.append(c)
    return merged


_ALNUM_RE = _Lazy(r'[^\W_]+')
_COMPOUND_RE = _Lazy(r'[\w-]+')
PARTS_CHARS = 6000


def parts_of(text: str) -> str:
    """The second FTS column. For every distinct hyphen/underscore compound it holds the compound
    without leading/trailing dashes (`--flag-name` -> `flag-name`) and its pieces as a contiguous
    phrase (`flag name`), so whole-token, stripped-token, piece and piece-phrase searches all match."""
    if '-' not in text and '_' not in text:
        return ''
    seen, out, total = set(), [], 0
    for tok in text.split():
        if '-' not in tok and '_' not in tok:
            continue
        for comp in _COMPOUND_RE.findall(tok.lower()):
            if ('-' not in comp and '_' not in comp) or comp in seen:
                continue
            seen.add(comp)
            pieces = _ALNUM_RE.findall(comp)
            if not pieces:
                continue
            stripped = comp.strip('-_')
            if stripped != comp and ('-' in stripped or '_' in stripped):
                out.append(stripped)
                total += len(stripped) + 1
            out.append(' '.join(pieces))
            total += len(out[-1]) + 1
            if total > PARTS_CHARS:
                return ' '.join(out)[:PARTS_CHARS]
    return ' '.join(out)


# --------------------------------------------------------------------------------------------
# Human prompt cleaning (Claude Code wrappers)

_DROP_TAGS = ('system-reminder', 'task-notification', 'local-command-caveat', 'local-command-stdout',
              'local-command-stderr', 'bash-stdout', 'bash-stderr', 'ci-monitor-event', 'agent-message',
              'user-prompt-submit-hook', 'ide_selection', 'ide_opened_file', 'command-message',
              'skill-format', 'command-contents', 'new-diagnostics', 'environment_context',
              'user_instructions', 'peer-message', 'channel-message', 'teammate-message')
_DROP_RE = _Lazy(r'<(' + '|'.join(re.escape(t) for t in _DROP_TAGS) + r')\b[^>]*>[\s\S]*?</\1\s*>', re.I)
_DROP_OPEN_RE = _Lazy(r'<(system-reminder|task-notification)\b[^>]*>[\s\S]*\Z', re.I)
_CMD_NAME_RE = _Lazy(r'<command-name>\s*([\s\S]*?)\s*</command-name>')
_CMD_ARGS_RE = _Lazy(r'<command-args>([\s\S]*?)</command-args>')
_BASH_INPUT_RE = _Lazy(r'<bash-input>([\s\S]*?)</bash-input>')
_PASTED_RE = _Lazy(r'<pasted_content\b[^>]*>([\s\S]*?)</pasted_content\b[^>]*>')
_SCHED_RE = _Lazy(r'<scheduled-task\b([^>]*)>([\s\S]*?)(?:</scheduled-task\s*>|\Z)')
_SCHED_NAME_RE = _Lazy(r'\bname\s*=\s*"([^"]*)"')
_NOTIF_RE = _Lazy(r'<task-notification\b[^>]*>([\s\S]*?)(?:</task-notification\s*>|\Z)')
_NOTIF_SUMMARY_RE = _Lazy(r'<summary>([\s\S]*?)</summary>')
_NOTIF_ID_RE = _Lazy(r'<task-id>([\s\S]*?)</task-id>')
_NOTIF_STATUS_RE = _Lazy(r'<status>([\s\S]*?)</status>')
_INTERRUPT_RE = _Lazy(r'^\[Request interrupted by user[^\]]*\]$')
_COMPACT_PREFIX = 'This session is being continued from a previous conversation'
PASTE_CHARS = 1200
PROMPT_CHARS = 12_000
SUB_PROMPT_CHARS = 4_000


def scheduled_task_name(text: str) -> str | None:
    if '<scheduled-task' not in text:
        return None
    m = _SCHED_RE.search(text)
    if not m:
        return None
    n = _SCHED_NAME_RE.search(m.group(1))
    return n.group(1) if n else 'scheduled-task'


def clean_human(text: str):
    """(clean text, typed text without pasted content, bash-input commands) of a human message."""
    bash = [b.strip() for b in _BASH_INPUT_RE.findall(text) if b.strip()]
    if bash:
        text = _BASH_INPUT_RE.sub(' ', text)
    if '<command-name>' in text:
        names = _CMD_NAME_RE.findall(text)
        args = _CMD_ARGS_RE.findall(text)
        if names:
            name = names[0].strip()
            if name and not name.startswith('/'):
                name = '/' + name
            line = (name + ' ' + (args[0].strip() if args else '')).strip()
            text = _CMD_ARGS_RE.sub(' ', _CMD_NAME_RE.sub(' ', text))
            text = line + '\n' + text
    if '<scheduled-task' in text:
        text = _SCHED_RE.sub(lambda m: m.group(2), text)
    text = _DROP_RE.sub(' ', text)
    text = _DROP_OPEN_RE.sub(' ', text)
    typed = text
    if '<pasted_content' in text:
        def paste(m):
            body = m.group(1).strip('\n')
            if len(body) > PASTE_CHARS:
                body = body[:PASTE_CHARS].rstrip() + '\n…[pasted, %d chars]' % len(m.group(1))
            return '\n' + body + '\n'
        typed = _PASTED_RE.sub(' ', text)
        text = _PASTED_RE.sub(paste, text)
    norm = lambda s: re.sub(r'\n{3,}', '\n\n', re.sub(r'[ \t]+\n', '\n', s)).strip()
    return norm(text), norm(typed), bash


# --------------------------------------------------------------------------------------------
# Decision heuristics (no model)

_ASK_PHRASE_RE = _Lazy(
    r"\b(?:want me to|should i|shall i|do you want|would you like|which (?:one|option|approach|of|do you|would you|should)"
    r"|do you prefer|would you prefer|let me know (?:if|whether|which)|ok to|okay to|good to go|sound good|go ahead\?)", re.I)
_ASK_OPTIONS_RE = _Lazy(
    r'(?:\(a\)[\s\S]{0,600}?\(b\))|(?:\bOption\s+(?:A|1)\b)|(?:^[ \t]*(?:\*\*)?(?:1[.)]|\(1\))[\s\S]{0,800}?^[ \t]*(?:\*\*)?(?:2[.)]|\(2\)))',
    re.I | re.M)
_REPLY_RE = _Lazy(
    r"^\s*(?:"
    r"(?:yes|yeah|yep|yup|ya|ok|okay|sure|go\s+ahead|go\s+with|go\s+for\s+it|do\s+it|do\s+both|do\s+all|do\s+that"
    r"|approved?|let'?s|lets|i'?ll\s+take|i'?d\s+(?:go|take|prefer)|both|all\s+of\s+(?:them|it|those)|all|no|nope|nah|skip"
    r"|don'?t|do\s+not|please\s+do|sounds\s+good|lgtm|ship\s+it|proceed|continue|option\s+\w+"
    r"|(?:the\s+)?(?:first|second|third|former|latter)(?:\s+one)?)\b"
    r"|\(?[a-dA-D]\)?(?:\s*(?:,|and|&|\+|or)\s*\(?[a-dA-D]\)?)*(?=\s*$|[.,:;!)]|\s+(?:and|or|then|but|please|first|plus|with|is|sounds|looks)\b|\s*[-—])"
    r"|\(?[1-9]\)?(?:\s*(?:,|and|&|\+|or)\s*\(?[1-9]\)?)*(?=\s*$|[.,:;!)]|\s+(?:and|or|then|but|please|first|plus|with|is|sounds|looks|works)\b|\s*[-—])"
    r")", re.I)
_DECISION_RES = [_Lazy(p, re.I) for p in (
    r"\bwe(?:\s+(?:are|will)|['’](?:re|ll))\s+(?:not\s+|never\s+)?(?:going\s+to\s+)?(?:use|be\s+using|go\s+with)\b",
    r"\blet'?s\s+go\s+with\b",
    r"\bwe\s+definitely\b",
    r"\bfor\s+now,?\s+we\s+(?:can|will|'ll)\b",
    r"\bmake\s+(?:\S+\s+){0,6}?the\s+default\b",
    r"(?<![\w'])(?!(?:it|this|that|everything|anything|all|which|what|who|there|here|he|she|they|which)\s)"
    r"[A-Za-z0-9][\w.\-/+#]*(?:\s+[\w.\-/+#]+){0,5}\s+is\s+fine\b(?![\s-]*(?:tun|grain))",
    r"\buse\s+(?:[^\s.,;!?]+\s+){1,4}instead\b",
    r"\b(?:is|are)\s+not\s+(?:a\s+)?blockers?\b|\b(?:isn'?t|aren'?t)\s+(?:a\s+)?blockers?\b",
    r"^\W*approved\b|\b(?:is|are|was|were|been)\s+approved\b|\bi\s+approve\b",
    r"\bI\s+want\s+to\s+state\s+that\b",
)]


_CONDITIONAL_RE = _Lazy(r"\b(?:if|when|whenever|once|until|unless|whether|after|before)\b[^.;:!?]*$", re.I)


def is_ask(text: str) -> bool:
    t = (text or '').strip()
    if not t:
        return False
    tail = t[-600:]
    if re.search(r'\?[\s*_`")\]]*$', tail):
        return True
    last_par = re.split(r'\n[ \t]*\n', tail)[-1]
    if '?' in last_par and _ASK_PHRASE_RE.search(last_par):
        return True
    if _ASK_OPTIONS_RE.search(tail) and (_ASK_PHRASE_RE.search(tail) or '?' in tail):
        return True
    return False


def is_choice_reply(text: str) -> bool:
    t = (text or '').strip()
    return 0 < len(t) <= 250 and bool(_REPLY_RE.match(t))


def ask_decision(ask: str, reply: str) -> str:
    q = re.sub(r'\s+', ' ', ask).strip()
    if len(q) > 300:
        q = q[-300:]
        sp = q.find(' ')
        q = '…' + (q[sp + 1:] if 0 <= sp < 40 else q)
    return 'Q: %s → A: %s' % (q, one_line(reply, 250))


def decision_sentences(text: str) -> list:
    """Sentences of human text with explicit decision language."""
    out = []
    in_code = False
    for line in (text or '').split('\n'):
        if line.lstrip().startswith(('```', '~~~')):
            in_code = not in_code
            continue
        if in_code or line.startswith(('    ', '\t')):
            continue
        line = line.strip().lstrip('-*>#• \t').strip()
        if not line or line.startswith(('|', '$ ')):
            continue
        for sent in re.split(r'(?<=[.!?])\s+(?=[A-Z0-9"\'(])', line):
            s = sent.strip()
            if len(s) < 6 or s.endswith('?'):
                continue
            for rx in _DECISION_RES:
                m = rx.search(s)
                if m and _CONDITIONAL_RE.search(s[max(0, m.start() - 60):m.start() + 1]):
                    m = None  # "if the specs are approved ..." states no decision
                if m:
                    if len(s) > 400:
                        a = max(0, m.start() - 200)
                        s = ('…' if a else '') + s[a:a + 400].strip() + '…'
                    out.append(s)
                    break
            if len(out) >= 8:
                return out
    return out


# --------------------------------------------------------------------------------------------
# Git / GitHub detection in shell commands

_GIT_SUB = r'\bgit(?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?))*\s+'
_COMMIT_CMD_RE = _Lazy(_GIT_SUB + r'commit\b')
_COMMIT_LINE_RE = _Lazy(r'^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$', re.M)
_SHA_LINE_RE = _Lazy(r'^([0-9a-f]{7,40})(?:\s+(.*))?$', re.M)
_PR_URL_RE = _Lazy(r'https://github\.com/([\w.\-]+/[\w.\-]+)/pull/(\d+)\b')
_ISSUE_URL_RE = _Lazy(r'https://github\.com/([\w.\-]+/[\w.\-]+)/issues/(\d+)\b')
_GH_PR_CREATE_RE = _Lazy(r'\bgh\s+pr\s+create\b')
_GH_ISSUE_CREATE_RE = _Lazy(r'\bgh\s+issue\s+create\b')


_SHELL_TOKEN_RE = _Lazy(
    r"""(?:[ \t]|\\\n)*(?:(&&|\|\||[;|\n])|((?:[^\s'"\\;&|]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+))""")
_SHELL_PART_RE = _Lazy(r"""'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)|([^'"\\]+)""", re.S)


def _unquote(word: str) -> str:
    if "'" not in word and '"' not in word and '\\' not in word:
        return word
    out = []
    for m in _SHELL_PART_RE.finditer(word):
        if m.group(1) is not None:
            out.append(m.group(1))
        elif m.group(2) is not None:
            out.append(re.sub(r'\\([\\"$`])', r'\1', m.group(2)))
        elif m.group(3) is not None:
            out.append(m.group(3))
        else:
            out.append(m.group(4))
    return ''.join(out)


def _shell_args_after(cmd: str, start: int, limit: int = 200) -> list:
    """Shell words from `start` to the end of that command (stops at && || ; | or a newline)."""
    words, pos, end = [], start, min(len(cmd), start + 8000)
    match = _SHELL_TOKEN_RE.match
    while pos < end and len(words) < limit:
        m = match(cmd, pos, end)
        if not m or m.end() == pos:
            break
        pos = m.end()
        if m.group(1):
            break
        if m.group(2):
            words.append(_unquote(m.group(2)))
    return words


def commit_message(cmd: str) -> str:
    m = _COMMIT_CMD_RE.search(cmd)
    if not m:
        return ''
    rest = cmd[m.end():]
    h = re.match(r"[^\n]*?(?:-F\s*-|--file[= ]-)[^\n]*?<<-?\s*(['\"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?:\n|$)", rest)
    if h:
        return h.group(3).strip()
    h = re.match(r"[^\n]*?-[a-zA-Z]*m\s*\"\$\(cat\s*<<-?\s*(['\"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2", rest)
    if h:
        return h.group(3).strip()
    words = _shell_args_after(cmd, m.end())
    msgs, i = [], 0
    while i < len(words):
        w = words[i]
        if w.startswith('--message='):
            msgs.append(w.split('=', 1)[1])
        elif w == '--message' and i + 1 < len(words):
            msgs.append(words[i + 1])
            i += 1
        elif re.fullmatch(r'-[a-zA-Z]*m', w) and i + 1 < len(words):
            msgs.append(words[i + 1])
            i += 1
        elif re.fullmatch(r'-[a-zA-Z]*m.+', w) and not w.startswith('--'):
            msgs.append(w[w.index('m') + 1:])
        i += 1
    return '\n\n'.join(x.strip() for x in msgs if x.strip())


def option_value(cmd: str, start: int, names: tuple) -> str:
    words = _shell_args_after(cmd, start)
    for i, w in enumerate(words):
        for n in names:
            if w == n and i + 1 < len(words):
                return words[i + 1]
            if n.startswith('--') and w.startswith(n + '='):
                return w.split('=', 1)[1]
    return ''


# --------------------------------------------------------------------------------------------
# Command classification: read-only inspection vs. actions

_INSPECT_PROGRAMS = frozenset((
    'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'ls', 'll', 'find', 'fd', 'wc', 'stat',
    'echo', 'printf', 'pwd', 'which', 'type', 'whereis', 'ps', 'pgrep', 'lsof', 'df', 'du', 'sleep', 'date', 'tree',
    'file', 'less', 'more', 'diff', 'cmp', 'jq', 'yq', 'sort', 'uniq', 'cut', 'tr', 'column', 'nl', 'realpath',
    'readlink', 'basename', 'dirname', 'whoami', 'id', 'uname', 'hostname', 'uptime', 'printenv', 'awk', 'xxd',
    'hexdump', 'od', 'strings', 'shasum', 'sha256sum', 'sha1sum', 'md5', 'md5sum', 'nproc', 'vm_stat', 'top', 'free',
    'nvidia-smi', 'sw_vers', 'otool', 'nm', 'tac', 'rev', 'fold', 'journalctl', 'memory_pressure', 'sysctl', 'netstat',
    'ifconfig', 'man', 'tldr', 'zcat', 'bat', 'mdls', 'mdfind', 'locate', 'getconf', 'ulimit', 'groups', 'w', 'who',
    'last', 'cal', 'locale', 'pip-licenses',
))
_NEUTRAL_PROGRAMS = frozenset((
    'cd', 'pushd', 'popd', 'export', 'set', 'unset', 'source', '.', 'true', 'false', ':', 'test', '[', '[[', 'wait',
    'local', 'shopt', 'trap', 'alias', 'for', 'case', 'esac', 'fi', 'done', '}', ')', 'in', 'select', 'break',
    'continue', 'return', 'declare', 'typeset', 'setopt', 'unsetopt', 'emulate', 'hash', 'rehash',
))
_WRAPPERS = frozenset(('time', 'nohup', 'command', 'builtin', 'exec', 'then', 'do', 'else', 'elif', 'if', 'while',
                       'until', '!', '{', '(', 'sudo', 'nice', 'timeout', 'env', 'caffeinate', 'stdbuf'))
_SUBCOMMAND_INSPECT = {
    'git': frozenset(('status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'blame',
                      'describe', 'shortlog', 'reflog', 'grep', 'show-ref', 'for-each-ref', 'rev-list', 'merge-base',
                      'name-rev', 'whatchanged', 'count-objects', 'check-ignore', 'ls-remote', 'help', 'version',
                      '--version', 'diff-tree', 'diff-index', 'diff-files', 'show-branch', 'var', 'cherry')),
    'docker': frozenset(('ps', 'images', 'logs', 'inspect', 'stats', 'version', 'info', 'top', 'port', 'history')),
    'kubectl': frozenset(('get', 'describe', 'logs', 'version', 'top', 'explain', 'api-resources')),
    'brew': frozenset(('list', 'ls', 'info', 'search', 'outdated', 'config', 'deps', 'leaves', '--version', 'doctor')),
    'npm': frozenset(('ls', 'list', 'view', 'info', 'outdated', 'why', '--version', '-v', 'help')),
    'pnpm': frozenset(('ls', 'list', 'outdated', 'why', '--version')),
    'yarn': frozenset(('list', 'info', 'why', '--version')),
    'pip': frozenset(('list', 'show', 'freeze', '--version', 'check', 'help')),
    'pip3': frozenset(('list', 'show', 'freeze', '--version', 'check', 'help')),
    'conda': frozenset(('list', 'info', '--version')),
    'launchctl': frozenset(('list', 'print')),
    'defaults': frozenset(('read', 'read-type', 'domains')),
    'systemctl': frozenset(('status', 'list-units', 'is-active', 'is-enabled', 'show', 'list-timers')),
    'tmux': frozenset(('ls', 'list-sessions', 'list-windows', 'list-panes', 'capture-pane', 'show-options')),
    'uv': frozenset(('--version', 'version', 'tree')),
    'cargo': frozenset(('--version', 'tree', 'metadata')),
    'go': frozenset(('version', 'env', 'list', 'doc')),
}
_GH_INSPECT = {
    'pr': frozenset(('view', 'list', 'checks', 'diff', 'status')), 'issue': frozenset(('view', 'list', 'status')),
    'run': frozenset(('view', 'list', 'watch')), 'release': frozenset(('view', 'list')), 'repo': frozenset(('view',)),
    'auth': frozenset(('status',)), 'workflow': frozenset(('view', 'list')), 'label': frozenset(('list',)),
    'search': None, 'status': None, 'browse': None,
}
_GIT_BRANCH_LIST_FLAGS = frozenset(('-a', '-r', '-v', '-vv', '-av', '-avv', '-l', '--list', '--all', '--remotes',
                                    '--show-current', '--verbose', '--no-color', '--color', '--column', '--no-column'))
_HEREDOC_RE = _Lazy(r"<<(-?)[ \t]*(['\"]?)([A-Za-z_][\w.-]*)\2")
_REDIRECT_RE = _Lazy(r'(?<![<>&])(?:\d|&)?>>?\|?[ \t]*(?!&)(\S+)')
_PY_WRITE_HINTS = (
    '.write', 'os.remove', 'os.unlink', 'os.rename', 'os.replace', 'os.makedirs', 'os.mkdir', 'os.rmdir', 'os.system',
    'os.chmod', 'os.chown', 'os.kill', 'os.symlink', 'os.link', 'os.truncate', 'os.popen', 'os.exec', 'os.spawn',
    'os.fork', 'shutil.', 'subprocess', 'Popen', '.unlink(', 'rmtree', '.to_csv(', '.to_parquet(', '.to_json(',
    '.to_pickle(', '.to_excel(', '.to_sql(', '.to_feather(', '.to_hdf(', '.save', 'json.dump(', 'pickle.dump',
    'requests.post', 'requests.put', 'requests.delete', 'requests.patch', 'urlopen', 'sqlite3', '.execute(',
    '.commit(', 'exec(', '__import__', 'socket', 'http.client', 'smtplib', '.mkdir(', '.touch(', '.rename(',
    '.chmod(', '.symlink_to(', 'input(', 'sleep(', 'while True')
_PY_OPEN_WRITE_RE = _Lazy(r"""open\([^)]*['"][wax][bt+]?['"]""")
_PYTHON_PROG_RE = _Lazy(r'^(?:python[0-9.]*|py|pypy[0-9.]*)$')


_SEG_TOKEN_RE = _Lazy(
    r"""(?P<run>(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^'"\\;|&#()$\n]|\$(?!\())+)|(?P<nl>\n)"""
    r"""|(?P<open>'[^']*|"(?:[^"\\]|\\.)*)|(?P<sub>\$\()|(?P<sep>&&|\|\||;;|[;|&])|(?P<par>[()])|(?P<hash>#)"""
    r"""|(?P<other>.)""", re.S)
_INSPECT_CACHE = {}
_FIRST_WORD_RE = _Lazy(r'\s*([A-Za-z0-9_./~+\[-]+)(?=\s|$)')


def _unquoted(segment: str) -> str:
    """The segment with quoted strings blanked out (for spotting redirections)."""
    return re.sub(r"'[^']*'|\"(?:[^\"\\]|\\.)*\"", 'Q', segment)


def _split_segments(cmd: str) -> list:
    """Shell command segments split on unquoted ; && || | & and newlines (heredoc bodies removed),
    each as (segment text, heredoc bodies that belong to it)."""
    if not any(c in cmd for c in ';|&\n#'):
        return [(cmd.strip(), [])] if cmd.strip() else []  # one simple command
    lines = cmd.split('\n')
    kept, bodies = [], []
    i = 0
    while i < len(lines):
        line = lines[i]
        kept.append(line)
        i += 1
        if '<<' not in line:
            continue
        for dash, _q, marker in _HEREDOC_RE.findall(line):
            body = []
            while i < len(lines):
                ln = lines[i]
                i += 1
                if (ln.lstrip('\t') if dash else ln).strip() == marker:
                    break
                body.append(ln)
            bodies.append('\n'.join(body))
    text = '\n'.join(kept)
    segs, cur = [], []

    def flush():
        seg = ''.join(cur).strip()
        if seg:
            segs.append(seg)
        cur.clear()
    depth, comment = 0, False
    for m in _SEG_TOKEN_RE.finditer(text):
        kind, tok = m.lastgroup, m.group(0)
        if comment:
            if kind != 'nl':
                continue
            comment = False
        if kind == 'run' or kind == 'other' or kind == 'open':
            cur.append(tok)
        elif kind == 'nl':
            if depth:
                cur.append(tok)
            else:
                flush()
        elif kind == 'sub':
            depth += 1
            cur.append(tok)
        elif kind == 'par':
            if tok == ')' and depth:
                depth -= 1
            cur.append(tok)
        elif kind == 'hash':
            if depth == 0 and (m.start() == 0 or text[m.start() - 1].isspace()):
                comment = True  # a comment runs to the end of the line
            else:
                cur.append(tok)
        elif depth:
            cur.append(tok)
        else:
            prev = text[m.start() - 1] if m.start() else ''
            nxt = text[m.end()] if m.end() < len(text) else ''
            if (tok == '&' and (prev in '<>' or nxt == '>')) or (tok == '|' and prev == '>'):
                cur.append(tok)  # 2>&1, &>file, >| file
            else:
                flush()
    flush()
    out = []
    for seg in segs:
        n = len(_HEREDOC_RE.findall(seg)) if '<<' in seg else 0
        out.append((seg, bodies[:n]))
        bodies = bodies[n:]
    return out


def _segment_kind(segment: str, bodies: list) -> str:
    """'inspect', 'neutral' or 'action' for one simple command."""
    for m in _REDIRECT_RE.finditer(_unquoted(segment)):
        target = m.group(1)
        if target not in ('/dev/null', '/dev/stderr', '/dev/stdout') and not target.startswith('&'):
            return 'action'  # writes a file
    m = _FIRST_WORD_RE.match(segment)
    if m:
        prog = m.group(1).rsplit('/', 1)[-1]
        if prog in _INSPECT_PROGRAMS and prog != 'find':
            return 'inspect'
        if prog in _NEUTRAL_PROGRAMS:
            return 'neutral'
    words = _shell_args_after(segment, 0, 12)
    if len(words) == 12 and re.match(r'^(?:\S+=\S*\s+)*(?:\S*/)?(?:sed|find|gh|xargs|timeout|env|sudo|nice)\b', segment):
        words = _shell_args_after(segment, 0, 80)  # flags that matter may come late
    while words:
        w = words[0]
        if '=' in w and re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', w):
            words = words[1:]
            continue
        if w in _WRAPPERS:
            words = words[1:]
            if w == 'timeout':
                while words and words[0].startswith('-'):
                    words = words[1:]
                words = words[1:]
            elif w in ('nice', 'sudo', 'env', 'caffeinate', 'stdbuf'):
                while words and words[0].startswith('-'):
                    words = words[2:] if words[0] in ('-n', '-u', '-g') else words[1:]
            continue
        break
    if not words:
        return 'neutral'
    prog = os.path.basename(words[0])
    args = words[1:]
    if prog == 'xargs':
        while args and args[0].startswith('-'):
            args = args[2:] if args[0] in ('-n', '-I', '-P', '-L', '-s', '-E', '-d') else args[1:]
        return _segment_kind(' '.join(shlex_quote(a) for a in args), []) if args else 'inspect'
    if prog in _NEUTRAL_PROGRAMS:
        return 'neutral'
    if prog == 'sed':
        return 'action' if any(a == '--in-place' or re.match(r'^-[a-zA-Z]*i', a) for a in args) else 'inspect'
    if prog == 'find':
        if '-delete' in args:
            return 'action'
        for flag in ('-exec', '-execdir', '-ok', '-okdir'):
            if flag in args:
                k = args.index(flag)
                if k + 1 >= len(args) or os.path.basename(args[k + 1]) not in _INSPECT_PROGRAMS:
                    return 'action'
        return 'inspect'
    if prog in _INSPECT_PROGRAMS:
        return 'inspect'
    if prog == 'git':
        while args and args[0].startswith('-') and args[0] not in ('--version', '--help'):
            args = args[2:] if args[0] in ('-C', '-c') else args[1:]
        if not args:
            return 'inspect'
        sub, rest = args[0], args[1:]
        if sub in _SUBCOMMAND_INSPECT['git']:
            return 'inspect'
        if sub == 'branch':
            return 'inspect' if all(a in _GIT_BRANCH_LIST_FLAGS or a.startswith(('--sort', '--format', '--contains',
                                                                                   '--merged', '--no-merged'))
                                    for a in rest) else 'action'
        if sub == 'remote':
            return 'inspect' if not rest or rest[0] in ('-v', '--verbose', 'show', 'get-url') else 'action'
        if sub == 'stash':
            return 'inspect' if rest and rest[0] in ('list', 'show') else 'action'
        if sub == 'worktree':
            return 'inspect' if rest and rest[0] == 'list' else 'action'
        if sub == 'tag':
            return 'inspect' if not rest or rest[0] in ('-l', '--list', '-n') else 'action'
        if sub == 'config':
            return 'inspect' if rest and rest[0] in ('--get', '--get-all', '--get-regexp', '--list', '-l') else 'action'
        return 'action'
    if prog == 'gh':
        if not args:
            return 'inspect'
        group = args[0]
        if group == 'api':
            writes = any(a in ('-f', '-F', '--field', '--raw-field', '--input') or a.startswith(('--field=', '--raw-field='))
                         for a in args)
            method = option_value(' '.join(shlex_quote(a) for a in args), 0, ('-X', '--method')).upper()
            return 'action' if writes or method not in ('', 'GET') else 'inspect'
        if group in _GH_INSPECT:
            verbs = _GH_INSPECT[group]
            if verbs is None:
                return 'inspect'
            return 'inspect' if len(args) > 1 and args[1] in verbs else 'action'
        return 'action'
    if prog in _SUBCOMMAND_INSPECT:
        sub = next((a for a in args if not a.startswith('-')), None) or (args[0] if args else '')
        return 'inspect' if (not args or sub in _SUBCOMMAND_INSPECT[prog]) else 'action'
    if _PYTHON_PROG_RE.match(prog):
        if args in (['--version'], ['-V'], ['-VV']):
            return 'inspect'
        if args[:2] in (['-m', 'json.tool'], ['-m', 'pip']):
            return 'inspect' if args[1] == 'json.tool' or (len(args) > 2 and args[2] in ('list', 'show', 'freeze')) \
                else 'action'
        code = None
        if '-c' in args:
            k = args.index('-c')
            code = args[k + 1] if k + 1 < len(args) else ''
        elif bodies and (not args or args[0] == '-'):
            code = '\n'.join(bodies)
        if code is not None and _py_print_only(code):
            return 'inspect'
        return 'action'
    return 'action'


def _py_print_only(code: str) -> bool:
    """Python source that prints and does nothing else visible (no writes, processes or network)."""
    if 'print' not in code or any(h in code for h in _PY_WRITE_HINTS):
        return False
    return not ('open(' in code and _PY_OPEN_WRITE_RE.search(code))


def shlex_quote(word: str) -> str:
    if word and re.fullmatch(r'[\w@%+=:,./-]+', word):
        return word
    return "'" + word.replace("'", "'\"'\"'") + "'"


def is_inspection(cmd: str) -> bool:
    """True when every part of a shell command only reads or prints (no writes, no actions)."""
    if not cmd or len(cmd) > 4000:
        return False  # long commands (scripts, file-writing heredocs) count as actions
    hit = _INSPECT_CACHE.get(cmd)
    if hit is not None:
        return hit
    result = False
    try:
        for seg, bodies in _split_segments(cmd or ''):
            kind = _segment_kind(seg, bodies)
            if kind == 'action':
                result = False
                break
            if kind == 'inspect':
                result = True
    except (ValueError, IndexError, RecursionError):
        result = False
    if len(_INSPECT_CACHE) > 50_000:
        _INSPECT_CACHE.clear()
    _INSPECT_CACHE[cmd] = result
    return result


# --------------------------------------------------------------------------------------------
# Database

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'main',
  size INTEGER NOT NULL DEFAULT 0,
  mtime REAL NOT NULL DEFAULT 0,
  offset INTEGER NOT NULL DEFAULT 0,
  head_len INTEGER NOT NULL DEFAULT 0,
  head_hash TEXT,
  session_id TEXT,
  project TEXT,
  agent TEXT,
  agent_name TEXT,
  skipped INTEGER NOT NULL DEFAULT 0,
  transcript_exists INTEGER NOT NULL DEFAULT 1,
  min_ts INTEGER,
  max_ts INTEGER,
  state TEXT,
  indexed_at INTEGER,
  fmt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS files_session ON files(session_id);
CREATE TABLE IF NOT EXISTS sessions(
  session_id TEXT PRIMARY KEY,
  source TEXT,
  project TEXT,
  project_name TEXT,
  cwd TEXT,
  title TEXT,
  first_ts INTEGER,
  last_ts INTEGER,
  first_prompt TEXT,
  prompt_count INTEGER NOT NULL DEFAULT 0,
  routine INTEGER NOT NULL DEFAULT 0,
  routine_name TEXT,
  branch TEXT,
  entrypoint TEXT,
  transcript_path TEXT,
  transcript_exists INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project, last_ts);
CREATE INDEX IF NOT EXISTS sessions_last ON sessions(last_ts);
CREATE TABLE IF NOT EXISTS docs(
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  project TEXT,
  ts INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  role TEXT,
  source TEXT,
  ref_uuid TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  sub INTEGER NOT NULL DEFAULT 0,
  file_id INTEGER,
  dkey TEXT UNIQUE,
  extra TEXT,
  flags INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS docs_text(
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  parts TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS docs_session ON docs(session_id, seq);
CREATE INDEX IF NOT EXISTS docs_session_kind ON docs(session_id, kind, ts);
CREATE INDEX IF NOT EXISTS docs_kind_ts ON docs(kind, ts);
CREATE INDEX IF NOT EXISTS docs_project_ts ON docs(project, ts);
CREATE INDEX IF NOT EXISTS docs_ts ON docs(ts);
CREATE INDEX IF NOT EXISTS docs_file ON docs(file_id, seq);
CREATE INDEX IF NOT EXISTS docs_source ON docs(source);
CREATE INDEX IF NOT EXISTS docs_sub ON docs(sub) WHERE sub > 0;
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  text, parts, content='docs_text', content_rowid='id', tokenize="porter unicode61 tokenchars '-_'");
CREATE TRIGGER IF NOT EXISTS docs_text_ai AFTER INSERT ON docs_text BEGIN
  INSERT INTO docs_fts(rowid, text, parts) VALUES (new.id, new.text, new.parts);
END;
CREATE TRIGGER IF NOT EXISTS docs_text_ad AFTER DELETE ON docs_text BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, text, parts) VALUES ('delete', old.id, old.text, old.parts);
END;
CREATE TRIGGER IF NOT EXISTS docs_text_au AFTER UPDATE ON docs_text BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, text, parts) VALUES ('delete', old.id, old.text, old.parts);
  INSERT INTO docs_fts(rowid, text, parts) VALUES (new.id, new.text, new.parts);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  DELETE FROM docs_text WHERE id = old.id;
END;
CREATE VIEW IF NOT EXISTS docs_all AS
  SELECT d.*, t.text AS text, t.parts AS parts FROM docs d JOIN docs_text t ON t.id = d.id;
CREATE TABLE IF NOT EXISTS uuids(
  session_id TEXT NOT NULL, uuid TEXT NOT NULL, file_id INTEGER NOT NULL,
  PRIMARY KEY(session_id, uuid)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS uuids_file ON uuids(file_id);
CREATE TABLE IF NOT EXISTS forgotten(kind TEXT NOT NULL, value TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY(kind, value));
CREATE TABLE IF NOT EXISTS cwd_projects(cwd TEXT PRIMARY KEY, project TEXT NOT NULL, at INTEGER);
CREATE TABLE IF NOT EXISTS project_paths(project TEXT NOT NULL, path TEXT NOT NULL,
  PRIMARY KEY(project, path)) WITHOUT ROWID;
"""


def _recency_sql(con, half_life_days: float, now: int) -> str:
    """An SQL expression for the recency factor of d.ts: SQLite's pow() when built in, else a Python function."""
    hl = max(0.01, float(half_life_days)) * DAY_MS
    try:
        con.execute('SELECT pow(0.5, 1.0)').fetchone()
        return 'CASE WHEN d.ts > 0 THEN pow(0.5, MAX(0, %d - d.ts) / %r) ELSE 0.5 END' % (now, hl)
    except sqlite3.OperationalError:
        con.create_function('recall_recency', 1, _recency_factory(half_life_days, now), deterministic=True)
        return 'recall_recency(d.ts)'


def _recency_factory(half_life_days: float, now: int):
    hl = max(0.01, float(half_life_days)) * DAY_MS

    def recency(ts):
        if not ts:
            return 0.5
        age = max(0, now - ts)
        return 0.5 ** (age / hl)
    return recency


def ensure_private_dir(path: str) -> None:
    if not os.path.isdir(path):
        os.makedirs(path, mode=0o700, exist_ok=True)
        try:
            os.chmod(path, 0o700)
        except OSError:
            pass


def connect(db_path: str) -> sqlite3.Connection:
    db_path = os.path.abspath(os.path.expanduser(db_path))
    ensure_private_dir(os.path.dirname(db_path))
    if not os.path.exists(db_path):
        fd = os.open(db_path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
    try:
        if os.stat(db_path).st_mode & 0o077:
            os.chmod(db_path, 0o600)
    except OSError:
        pass
    con = sqlite3.connect(db_path, timeout=15, isolation_level=None)
    con.execute('PRAGMA busy_timeout=15000')
    con.execute('PRAGMA journal_mode=WAL').fetchone()
    con.execute('PRAGMA synchronous=NORMAL')
    con.execute('PRAGMA temp_store=MEMORY')
    con.execute('PRAGMA cache_size=-65536')
    row = None
    try:
        row = con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    except sqlite3.OperationalError:
        row = None
    if row is None:
        con.execute('BEGIN IMMEDIATE')
        try:
            for stmt in _split_sql(SCHEMA):
                con.execute(stmt)
            # fewer, larger FTS segments: merge later, keep more pending terms in memory (persistent settings)
            con.execute("INSERT INTO docs_fts(docs_fts, rank) VALUES ('automerge', 16)")
            con.execute("INSERT INTO docs_fts(docs_fts, rank) VALUES ('crisismerge', 32)")
            con.execute("INSERT INTO docs_fts(docs_fts, rank) VALUES ('hashsize', 33554432)")
            con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),))
            con.execute('COMMIT')
        except Exception:
            con.execute('ROLLBACK')
            raise
    elif int(row[0]) == 1:
        _migrate_v1(con)
    elif int(row[0]) != SCHEMA_VERSION:
        raise RecallError('index %s has schema %s, this engine needs %s: delete it and run update'
                          % (db_path, row[0], SCHEMA_VERSION))
    for suffix in ('-wal', '-shm'):
        p = db_path + suffix
        try:
            if os.path.exists(p) and os.stat(p).st_mode & 0o077:
                os.chmod(p, 0o600)
        except OSError:
            pass
    return con


def _migrate_v1(con) -> None:
    """Schema 1 -> 2 in place (keeps every doc; the next update re-reads files once, see INDEX_FORMAT)."""
    con.execute('BEGIN IMMEDIATE')
    try:
        if 'flags' not in {r[1] for r in con.execute('PRAGMA table_info(docs)')}:
            con.execute('ALTER TABLE docs ADD COLUMN flags INTEGER NOT NULL DEFAULT 0')
        if 'fmt' not in {r[1] for r in con.execute('PRAGMA table_info(files)')}:
            con.execute('ALTER TABLE files ADD COLUMN fmt INTEGER NOT NULL DEFAULT 0')
        for stmt in _split_sql(SCHEMA):
            con.execute(stmt)
        con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),))
        con.execute('COMMIT')
    except Exception:
        con.execute('ROLLBACK')
        raise


def _split_sql(script: str) -> list:
    """Statements of SCHEMA (triggers contain semicolons inside BEGIN..END)."""
    out, cur = [], []
    for line in script.strip().split('\n'):
        cur.append(line)
        joined = '\n'.join(cur).strip()
        if joined.endswith(';') and (not joined.upper().startswith('CREATE TRIGGER') or joined.upper().endswith('END;')):
            out.append(joined)
            cur = []
    if cur and '\n'.join(cur).strip():
        out.append('\n'.join(cur).strip())
    return out


class Tx:
    """BEGIN IMMEDIATE .. COMMIT, rolled back on error."""

    def __init__(self, con):
        self.con = con

    def __enter__(self):
        self.con.execute('BEGIN IMMEDIATE')
        return self.con

    def __exit__(self, exc_type, exc, tb):
        self.con.execute('ROLLBACK' if exc_type else 'COMMIT')
        return False


def meta_get(con, key, default=None):
    row = con.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
    return row[0] if row else default


def meta_set(con, key, value):
    con.execute('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', (key, str(value)))


# --------------------------------------------------------------------------------------------
# Projects: canonical repo roots

_WORKTREE_RES = (
    re.compile(r'^(.+?)/\.claude/worktrees/[^/]+(?:/.*)?$'),
    re.compile(r'^(.+?)/\.claude-worktrees/[^/]+(?:/.*)?$'),
    re.compile(r'^(.+?)/\.claude-worktrees-[^/]+(?:/.*)?$'),
)


def strip_worktree(path: str) -> str:
    for rx in _WORKTREE_RES:
        m = rx.match(path)
        if m:
            return m.group(1)
    return path


def git_root(path: str) -> str | None:
    import subprocess
    env = dict(os.environ, GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0')
    try:
        r = subprocess.run(['git', '-C', path, 'rev-parse', '--git-common-dir', '--show-toplevel'],
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           timeout=3, env=env)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    lines = r.stdout.decode('utf-8', 'replace').splitlines()
    if not lines:
        return None
    common = lines[0].strip()
    if not os.path.isabs(common):
        common = os.path.normpath(os.path.join(path, common))
    if os.path.basename(common) == '.git':
        return os.path.dirname(common)
    top = lines[1].strip() if len(lines) > 1 else ''
    return top or None


class Projects:
    """cwd -> canonical project key, cached in memory and in the cwd_projects table."""

    def __init__(self, con):
        self.con = con
        self.cache = {}

    def key(self, cwd: str | None) -> str | None:
        if not cwd or not isinstance(cwd, str):
            return None
        if cwd.startswith('file://'):
            cwd = cwd[7:]
        cwd = os.path.normpath(cwd)
        hit = self.cache.get(cwd)
        if hit is not None:
            return hit
        row = self.con.execute('SELECT project FROM cwd_projects WHERE cwd=?', (cwd,)).fetchone()
        if row:
            self.cache[cwd] = row[0]
            return row[0]
        base = strip_worktree(cwd)
        key = base
        if os.path.isdir(base):
            root = git_root(base)
            if root:
                key = os.path.normpath(root)
        self.cache[cwd] = key
        try:
            self.con.execute('INSERT OR REPLACE INTO cwd_projects(cwd, project, at) VALUES (?,?,?)', (cwd, key, now_ms()))
        except sqlite3.OperationalError:
            pass  # read-only use; the cache still works
        return key


def known_project_keys(con) -> list:
    rows = con.execute('SELECT DISTINCT project FROM sessions WHERE project IS NOT NULL '
                       'UNION SELECT DISTINCT project FROM docs WHERE project IS NOT NULL AND session_id IS NULL').fetchall()
    return [r[0] for r in rows]


def resolve_projects(con, value: str | None):
    """None for no filter (`all` or not given), else the list of matching keys (maybe empty)."""
    if value is None:
        return None
    v = value.strip()
    if not v or v.lower() == 'all':
        return None
    keys = known_project_keys(con)
    if v.startswith('~'):
        v = os.path.expanduser(v)
    if v.startswith('/'):
        norm = os.path.normpath(v)
        if norm in keys:
            return [norm]
        if v in keys:
            return [v]
        stripped = strip_worktree(norm)
        if stripped in keys:
            return [stripped]
        row = con.execute('SELECT project FROM cwd_projects WHERE cwd=?', (norm,)).fetchone()
        if row:
            return [row[0]]
        if os.path.isdir(stripped):
            root = git_root(stripped)
            if root and os.path.normpath(root) in keys:
                return [os.path.normpath(root)]
        return [stripped]
    low = v.lower()
    return sorted({k for k in keys if k == v or (project_name(k) or '').lower() == low})


def _base36(n: int) -> str:
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    out = ''
    while True:
        n, r = divmod(n, 36)
        out = digits[r] + out
        if not n:
            return out


def second_opinion_key(root: str) -> str:
    """The folder name the second-opinion mod saves a project's reviews under: slug + FNV-1a (base 36)."""
    trimmed = root.rstrip('/') or root
    h = 0x811c9dc5
    data = trimmed.encode('utf-16-le')
    for i in range(0, len(data), 2):
        h ^= data[i] | (data[i + 1] << 8)
        h = (h * 0x01000193) & 0xffffffff
    base = trimmed.split('/')[-1]
    slug = re.sub(r'^[-.]+|[-.]+$', '', re.sub(r'[^a-z0-9._-]+', '-', base.lower()))[:40] or 'project'
    return '%s-%s' % (slug, _base36(h).rjust(7, '0'))


def unmangle(name: str, max_depth: int = 14) -> str | None:
    """The existing path whose ~/.claude/projects folder name is `name` (`-Users-me-x` -> /Users/me/x)."""
    target = name

    def mangle(s):
        return re.sub(r'[^A-Za-z0-9]', '-', s)

    def walk(path, mangled, depth):
        if depth > max_depth:
            return None
        try:
            entries = os.listdir(path)
        except OSError:
            return None
        for e in sorted(entries):
            m = mangled + '-' + mangle(e)
            if target == m or target.startswith(m + '-'):
                child = os.path.join(path, e)
                if not os.path.isdir(child):
                    continue
                if target == m:
                    return child
                found = walk(child, m, depth + 1)
                if found:
                    return found
        return None
    if not target.startswith('-'):
        return None
    return walk('/', '', 0)


# --------------------------------------------------------------------------------------------
# Indexer: per-update state shared by all parsers

class Indexer:
    def __init__(self, con, home: str, subagents: bool):
        self.con = con
        self.home = home
        self.subagents = subagents
        self.projects = Projects(con)
        self.added = 0
        self.removed = 0
        self.touched = set()
        self.buf = []
        self.buf_keys = {}
        self.seqs = {}
        self.codex_titles = None
        self.forgot_sessions, self.forgot_projects, self.forgot_before = {}, {}, 0
        for kind, value, at in con.execute('SELECT kind, value, at FROM forgotten'):
            if kind == 'session':
                self.forgot_sessions[value] = at
            elif kind == 'project':
                self.forgot_projects[value] = at
            elif kind == 'before':
                self.forgot_before = max(self.forgot_before, int(value))
        self.forgot_names = {(project_name(k) or '').lower(): at for k, at in self.forgot_projects.items()}

    def forgotten(self, sid, project, ts) -> bool:
        t = ts or 0
        if self.forgot_before and t and t < self.forgot_before:
            return True
        if sid and sid in self.forgot_sessions and t <= self.forgot_sessions[sid]:
            return True
        if project and self.forgot_projects:
            at = self.forgot_projects.get(project)
            if at is None and not project.startswith('/'):
                at = self.forgot_names.get(project.lower())
            if at is not None and t <= at:
                return True
        return False

    def next_seq(self, sid) -> int:
        if not sid:
            return 0
        n = self.seqs.get(sid)
        if n is None:
            row = self.con.execute('SELECT MAX(seq) FROM docs WHERE session_id=?', (sid,)).fetchone()
            n = (row[0] or 0) + 1
        self.seqs[sid] = n + 1
        return n

    # -- writing docs -----------------------------------------------------------------------
    def emit(self, doc: dict) -> None:
        self.buf.append(doc)
        if doc.get('dkey'):
            self.buf_keys[doc['dkey']] = doc
        if len(self.buf) >= 2000:
            self.flush()

    def flush(self) -> None:
        if not self.buf:
            return
        # ids are assigned here (the update holds the write lock) so docs and docs_text rows pair up
        start = (self.con.execute('SELECT MAX(id) FROM docs').fetchone()[0] or 0) + 1
        rows, texts = [], []
        for i, d in enumerate(self.buf):
            text = d['text']
            rows.append((start + i, d['sid'], d['project'], d['ts'] or 0, d['kind'], d['role'], d['source'], d['ref'],
                         d['seq'], d['sub'], d['file_id'], d.get('dkey'), dumps(d['extra']) if d.get('extra') else None,
                         d.get('flags') or 0))
            texts.append((start + i, text, parts_of(text), start + i))
        cur = self.con.executemany(
            'INSERT OR IGNORE INTO docs(id, session_id, project, ts, kind, role, source, ref_uuid, seq, sub, file_id, '
            'dkey, extra, flags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', rows)
        self.added += max(0, cur.rowcount)
        self.con.executemany('INSERT INTO docs_text(id, text, parts) SELECT ?, ?, ? '
                             'WHERE EXISTS (SELECT 1 FROM docs WHERE id = ?)', texts)
        self.buf = []
        self.buf_keys = {}

    def lookup(self, dkey):
        d = self.buf_keys.get(dkey)
        if d is not None:
            return d, None
        row = self.con.execute('SELECT d.id, t.text, d.extra, d.ts FROM docs d JOIN docs_text t ON t.id = d.id '
                               'WHERE d.dkey=?', (dkey,)).fetchone()
        if row:
            return None, {'id': row[0], 'text': row[1], 'extra': loads(row[2], {}) or {}, 'ts': row[3]}
        return None, None

    def delete_dkey(self, dkey) -> None:
        d = self.buf_keys.pop(dkey, None)
        if d is not None:
            self.buf = [x for x in self.buf if x is not d]
            return
        cur = self.con.execute('DELETE FROM docs WHERE dkey=?', (dkey,))
        self.removed += max(0, cur.rowcount)

    def delete_file_docs(self, file_id) -> None:
        self.flush()
        cur = self.con.execute('DELETE FROM docs WHERE file_id=?', (file_id,))
        self.removed += max(0, cur.rowcount)
        self.con.execute('DELETE FROM uuids WHERE file_id=?', (file_id,))

    # -- sessions ----------------------------------------------------------------------------
    def refresh_session(self, sid: str) -> None:
        """Recomputes a session row from its files' metadata and its docs."""
        con = self.con
        self.flush()
        rows = con.execute('SELECT id, path, source, kind, transcript_exists, min_ts, max_ts, state, project, size '
                           'FROM files WHERE session_id=? AND skipped=0', (sid,)).fetchall()
        ndocs = con.execute("SELECT COUNT(*) FROM docs WHERE session_id=? AND kind!='title'", (sid,)).fetchone()[0]

        def drop():
            con.execute('DELETE FROM sessions WHERE session_id=?', (sid,))
            self.delete_dkey('title:' + sid)
        if not ndocs:
            drop()  # nothing searchable (empty or unfinished transcript, or everything forgotten)
            return
        main_rows = [r for r in rows if r[3] == 'main']
        mains = main_rows or rows
        metas = [(r, (loads(r[7], {}) or {}).get('meta', {})) for r in mains]

        def latest(field):
            best = None
            for _, m in metas:
                v = m.get(field)
                if isinstance(v, list) and len(v) == 2 and v[1] and (best is None or (v[0] or 0) >= (best[0] or 0)):
                    best = v
            return best[1] if best else None

        # one project per session: the folder it was launched in (its first record's cwd)
        cwd, best_ts = None, None
        for r, m in metas:
            v = m.get('firstCwd')
            if isinstance(v, list) and len(v) == 2 and v[1] and (best_ts is None or (v[0] or 0) < best_ts):
                cwd, best_ts = v[1], v[0] or 0
        if not cwd:
            for r in mains:  # inherited launch folders (subagent-only sessions)
                launch = (loads(r[7], {}) or {}).get('launchCwd')
                if launch:
                    cwd = launch
                    break
        if not cwd:  # states written before launch folders were tracked
            cwd = next(((m.get('cwds') or [None])[0] for _, m in metas if m.get('cwds')), None) or latest('cwd')
        project = self.projects.key(cwd) if cwd else None
        if not project:
            project = next((r[8] for r in mains if r[8]), None)
        con.execute('UPDATE docs SET project=? WHERE session_id=? AND project IS NOT ?', (project, sid, project))
        title = latest('custom') or latest('agentName') or latest('ai') or latest('codexTitle')
        routine_name = next((m.get('routine') for _, m in metas if m.get('routine')), None)
        src = mains[0][2] if mains else 'claude'
        mins = [r[5] for r in rows if r[5]]
        maxs = [r[6] for r in rows if r[6]]
        first_ts = min(mins) if mins else None
        last_ts = max(maxs) if maxs else None
        if not first_ts or not last_ts:
            lo, hi = con.execute('SELECT MIN(ts), MAX(ts) FROM docs WHERE session_id=? AND ts>0', (sid,)).fetchone()
            first_ts, last_ts = first_ts or lo, last_ts or hi
        tpath, texists = None, 0
        best_rank = None
        for r in main_rows:  # only a main transcript can be resumed
            rank = (r[4], r[6] or 0, r[9] or 0)
            if best_rank is None or rank > best_rank:
                best_rank, tpath = rank, r[1]
            if r[4]:
                texists = 1
        stats = con.execute(
            "SELECT COUNT(DISTINCT ref_uuid) FROM docs WHERE session_id=? AND kind='prompt' AND sub=0", (sid,)).fetchone()
        first = con.execute("SELECT t.text FROM docs d JOIN docs_text t ON t.id = d.id WHERE d.session_id=? "
                            "AND d.kind='prompt' AND d.sub=0 ORDER BY d.ts, d.seq LIMIT 1", (sid,)).fetchone()
        con.execute(
            'INSERT OR REPLACE INTO sessions(session_id, source, project, project_name, cwd, title, first_ts, last_ts, '
            'first_prompt, prompt_count, routine, routine_name, branch, entrypoint, transcript_path, transcript_exists) '
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (sid, src, project, project_name(project), cwd, title, first_ts, last_ts,
             clip(first[0], 600) if first else None, stats[0] or 0, 1 if routine_name else 0, routine_name,
             latest('branch'), latest('entry'), tpath, texists))
        for _, m in metas:
            for p in (m.get('cwds') or [])[:30]:
                k = self.projects.key(p)
                if k:
                    con.execute('INSERT OR IGNORE INTO project_paths(project, path) VALUES (?,?)', (k, p))
        # the session title as a searchable doc
        dkey = 'title:' + sid
        bufdoc, row = self.lookup(dkey)
        title_ts = None
        for _, m in metas:
            for f in ('custom', 'agentName', 'ai', 'codexTitle'):
                v = m.get(f)
                if isinstance(v, list) and v[1] == title:
                    title_ts = v[0] if title_ts is None else max(title_ts, v[0] or 0)
        if title and not self.forgotten(sid, project, title_ts or last_ts or 0):
            text = mask_secrets(clip(title, 300))
            if row is None:
                self.emit({'sid': sid, 'project': project, 'ts': title_ts or last_ts or 0, 'kind': 'title',
                           'role': 'user', 'source': 'codex' if src == 'codex' else 'claude', 'ref': None,
                           'seq': 0, 'sub': 0, 'file_id': None, 'dkey': dkey, 'text': text, 'extra': None})
                self.flush()
            elif row['text'] != text:
                con.execute('UPDATE docs_text SET text=?, parts=? WHERE id=?', (text, parts_of(text), row['id']))
                con.execute('UPDATE docs SET ts=?, project=? WHERE id=?', (title_ts or last_ts or 0, project, row['id']))
        elif row is not None:
            self.delete_dkey(dkey)


# --------------------------------------------------------------------------------------------
# Parsers

class Parser:
    """Shared extraction logic for one transcript file."""
    source = 'claude'

    def __init__(self, ix: Indexer, frow: dict, state: dict):
        self.ix = ix
        self.file_id = frow['id']
        self.path = frow['path']
        self.is_sub = frow['kind'] == 'sub'
        self.agent = frow.get('agent')
        self.state = state
        self.meta = state.setdefault('meta', {})
        self.pending = state.setdefault('pending', {})
        self.sid = state.get('sid') or frow.get('session_id')
        self.project = state.get('project') or frow.get('project')
        self.launch_cwd = state.get('launchCwd')   # the session's first cwd: its project
        self.rec_cwd = state.get('recCwd') or self.launch_cwd
        self.min_ts = frow.get('min_ts')
        self.max_ts = frow.get('max_ts')
        self.ts = None
        self.ref = None
        self._cwd = None
        self._meta_raw = {}
        if self.is_sub and self.sid and not self.launch_cwd:
            self.inherit_parent()

    # -- context -----------------------------------------------------------------------------
    def see_ts(self, ts):
        if ts:
            self.ts = ts
            if self.min_ts is None or ts < self.min_ts:
                self.min_ts = ts
            if self.max_ts is None or ts > self.max_ts:
                self.max_ts = ts

    def inherit_parent(self):
        """A subagent belongs to its parent session's project (and launch folder)."""
        con = self.ix.con
        row = con.execute("SELECT state, project FROM files WHERE session_id=? AND kind='main' AND source=? "
                          "AND skipped=0 ORDER BY id LIMIT 1", (self.sid, self.source)).fetchone()
        launch, project = None, None
        if row:
            st = loads(row[0], {}) or {}
            launch = st.get('launchCwd') or ((st.get('meta') or {}).get('firstCwd') or [0, None])[1]
            project = st.get('project') or row[1]
        if not launch:
            srow = con.execute('SELECT cwd, project FROM sessions WHERE session_id=?', (self.sid,)).fetchone()
            if srow:
                launch, project = srow[0], srow[1]
        if launch:
            self.launch_cwd = launch
            self.state['launchCwd'] = launch
            self.project = project or self.ix.projects.key(launch)
            self.state['inherited'] = True

    def see_cwd(self, cwd, ts):
        if not cwd or not isinstance(cwd, str):
            return
        if cwd == self._cwd:
            cur = self.meta.get('cwd')
            if ts and cur and ts > (cur[0] or 0):
                cur[0] = ts
            return
        self._cwd = cwd
        if cwd.startswith('file://'):
            cwd = cwd[7:]
        cwd = os.path.normpath(cwd)
        self.rec_cwd = cwd
        self.state['recCwd'] = cwd
        if not self.launch_cwd:
            self.launch_cwd = cwd
            self.state['launchCwd'] = cwd
            self.meta['firstCwd'] = [ts or 0, cwd]
            self.project = self.ix.projects.key(cwd)
        cur = self.meta.get('cwd')
        if not cur or cur[1] != cwd:
            self.meta['cwd'] = [ts or 0, cwd]
            cwds = self.meta.setdefault('cwds', [])
            if cwd not in cwds and len(cwds) < 30:
                cwds.append(cwd)
        elif ts and ts > (cur[0] or 0):
            cur[0] = ts

    def cwd_extra(self, extra):
        """extra with the record's cwd when it is not the session's launch folder."""
        if self.rec_cwd and self.launch_cwd and self.rec_cwd != self.launch_cwd:
            extra = dict(extra or {})
            extra['cwd'] = self.rec_cwd
        return extra

    def set_meta(self, field, value, ts):
        if not value:
            return
        cur = self.meta.get(field)
        if cur and self._meta_raw.get(field) == value:  # unchanged: only the time moves
            if (ts or 0) > (cur[0] or 0):
                cur[0] = ts
            return
        self._meta_raw[field] = value
        masked = mask_secrets(value)
        if not cur or cur[1] != masked or (ts or 0) > (cur[0] or 0):
            self.meta[field] = [ts or 0, masked]

    def skip_now(self) -> bool:
        return self.ix.forgotten(self.sid, self.project, self.ts)

    def sub_flag(self) -> int:
        return 1 if self.is_sub else 0

    # -- doc writers -------------------------------------------------------------------------
    def doc(self, kind, text, role, extra=None, chunk=True, cap=20_000, dkey=None, ts=None, ref=None, flags=0):
        if not text or not self.sid or self.skip_now():
            return []
        text = mask_secrets(clip(text, cap))
        extra = self.cwd_extra(extra)
        extra = mask_obj(extra) if extra else None
        pieces = chunk_text(text) if chunk else [text.strip()]
        out = []
        for i, piece in enumerate(pieces):
            ex = dict(extra) if extra else {}
            if len(pieces) > 1:
                ex['chunk'] = i
            d = {'sid': self.sid, 'project': self.project, 'ts': ts or self.ts or 0, 'kind': kind, 'role': role,
                 'source': self.source, 'ref': ref or self.ref, 'seq': self.ix.next_seq(self.sid),
                 'sub': self.sub_flag(), 'file_id': self.file_id, 'dkey': dkey if (dkey and i == 0) else None,
                 'text': piece, 'extra': ex or None, 'flags': flags}
            self.ix.emit(d)
            out.append(d)
        return out

    def upsert(self, dkey, kind, role, new_extra, make_text, merge=None):
        """Insert or update the one doc with this key (files, tasks, commits, PRs, issues)."""
        if not self.sid or self.skip_now():
            return
        new_extra = mask_obj(new_extra)
        bufdoc, row = self.ix.lookup(dkey)
        if bufdoc is not None:
            merged = (merge or _patch)(bufdoc['extra'] or {}, new_extra)
            bufdoc['extra'] = merged
            bufdoc['text'] = mask_secrets(make_text(merged))
            return
        if row is not None:
            merged = (merge or _patch)(row['extra'], new_extra)
            text = mask_secrets(make_text(merged))
            if text != row['text']:
                self.ix.con.execute('UPDATE docs_text SET text=?, parts=? WHERE id=?', (text, parts_of(text), row['id']))
                self.ix.con.execute('UPDATE docs SET extra=? WHERE id=?', (dumps(merged), row['id']))
            elif merged != row['extra']:
                self.ix.con.execute('UPDATE docs SET extra=? WHERE id=?', (dumps(merged), row['id']))
            return
        merged = (merge or _patch)({}, mask_obj(self.cwd_extra(new_extra)))
        self.ix.emit({'sid': self.sid, 'project': self.project, 'ts': self.ts or 0, 'kind': kind, 'role': role,
                      'source': self.source, 'ref': self.ref, 'seq': self.ix.next_seq(self.sid),
                      'sub': self.sub_flag(), 'file_id': self.file_id, 'dkey': dkey,
                      'text': mask_secrets(make_text(merged)), 'extra': merged})

    def update_extra(self, dkey, patch):
        bufdoc, row = self.ix.lookup(dkey)
        patch = mask_obj(patch)
        if bufdoc is not None:
            bufdoc['extra'] = _patch(bufdoc['extra'] or {}, patch)
        elif row is not None:
            self.ix.con.execute('UPDATE docs SET extra=? WHERE id=?', (dumps(_patch(row['extra'], patch)), row['id']))

    # -- shared extraction ------------------------------------------------------------------
    def agent_key(self):
        return self.agent or 'main'

    def human(self, raw_text: str):
        """A human-typed message: prompt docs, bash-input commands and decisions."""
        if not raw_text or not raw_text.strip():
            return
        text = raw_text
        if text.lstrip().startswith(_COMPACT_PREFIX):
            self.summary(text)
            return
        if '<task-notification' in text:
            self.notifications(text)
        routine = scheduled_task_name(text)
        if routine and not self.is_sub:
            self.meta['routine'] = routine
        clean, typed, bash = clean_human(text)
        for cmd in bash:
            self.doc('command', cmd, 'user', extra={'user': True}, chunk=False, cap=CHUNK_CHARS)
        if not clean or _INTERRUPT_RE.match(clean):
            return
        extra = {'routine': True} if routine else None
        # a subagent's task prompt is the parent model's (often templated) instructions: keep less of it
        self.doc('prompt', clean, 'user', extra=extra, cap=SUB_PROMPT_CHARS if self.is_sub else PROMPT_CHARS)
        if self.is_sub or routine:
            self.state['ask'] = None
            return
        ask = self.state.get('ask')
        if ask and is_choice_reply(typed):
            self.doc('decision', ask_decision(ask['text'], typed), 'user', extra={'via': 'reply'},
                     chunk=False, cap=800)
        else:
            for sent in decision_sentences(typed):
                self.doc('decision', sent, 'user', extra={'via': 'statement'}, chunk=False, cap=800)
        self.state['ask'] = None

    def answer(self, text: str):
        t = (text or '').strip()
        if not t:
            return
        self.state['ask'] = {'text': mask_secrets(t[-1200:])} if is_ask(t) else None
        if len(t) < 40:
            return
        docs = self.doc('answer', t, 'assistant', cap=20_000)
        if docs and self.is_sub:
            self.state['last_answer'] = docs[0]['ref']

    def summary(self, text: str):
        t = text.strip()
        if t.startswith(_COMPACT_PREFIX):
            nl = t.find('\n')
            t = t[nl + 1:].strip() if nl > 0 else t
            t = re.sub(r'^Summary:\s*', '', t)
        self.doc('summary', t, 'assistant', cap=30_000)

    def notifications(self, text: str):
        for body in _NOTIF_RE.findall(text):
            s = _NOTIF_SUMMARY_RE.search(body)
            if not s:
                continue
            summary = one_line(s.group(1), 600)
            if len(summary) < 40:
                continue
            tid = _NOTIF_ID_RE.search(body)
            st = _NOTIF_STATUS_RE.search(body)
            key = 'notif:%s:%s:%s' % (self.sid, (tid.group(1).strip() if tid else sha(summary)),
                                      st.group(1).strip() if st else '')
            if self.ix.lookup(key) != (None, None):
                continue
            self.doc('answer', summary, 'notification', extra={'agent': True, 'notification': True},
                     chunk=False, dkey=key)

    def command(self, cmd: str, desc: str | None, call_id: str | None, role='assistant', extra=None):
        cmd = (cmd or '').strip()
        if not cmd:
            return None
        text = clip(cmd, CHUNK_CHARS)
        if desc:
            text = text + '\n# ' + one_line(desc, 200)
        flags = 0
        if is_inspection(cmd):
            extra = dict(extra or {}, inspect=True)
            flags = FLAG_INSPECT
        dkey = ('cmd:%s:%s' % (self.sid, call_id)) if call_id else None
        docs = self.doc('command', text, role, extra=extra, chunk=False, cap=CHUNK_CHARS + 260, dkey=dkey,
                        flags=flags)
        return dkey if docs else None

    def command_result(self, p: dict, out: str, is_err: bool, exit_code=None, git=None, interrupted=False):
        dkey = p.get('k')
        cmd = p.get('c') or ''
        if dkey and (is_err or interrupted):
            patch = {'error': one_line(out, 200) or 'error'}
            if exit_code is not None:
                patch['exit'] = exit_code
            if interrupted:
                patch['interrupted'] = True
            self.update_extra(dkey, patch)
        self.vcs(cmd, out or '', git if isinstance(git, dict) else None, is_err)

    def file_touch(self, path: str, tool: str):
        if not path or not isinstance(path, str):
            return
        path = path.strip()
        dkey = 'file:%s:%s:%s' % (self.sid, self.agent_key(), path)
        self.upsert(dkey, 'file', 'assistant', {'edits': 1, 'tool': tool, 'path': path},
                    lambda e: e.get('path') or path, merge=_count_edits)

    def url(self, text: str, extra: dict):
        self.doc('url', text, 'assistant', extra=extra, chunk=False, cap=600)

    def todo_list(self, items: list):
        """A full todo list (TodoWrite / update_plan): one task doc per item, final state wins."""
        keys = []
        for content, status in items:
            content = one_line(content, 800)
            if not content:
                continue
            dkey = 'todo:%s:%s:%s' % (self.sid, self.agent_key(), sha(content))
            if dkey in keys:
                continue
            keys.append(dkey)
            self.upsert(dkey, 'task', 'assistant', {'status': status or 'pending', 'subject': content},
                        lambda e: e.get('subject') or '')
        todos = self.state.setdefault('todos', {})
        old = todos.get(self.sid) or []
        for k in old:
            if k not in keys:
                self.ix.delete_dkey(k)
        todos[self.sid] = keys

    def task_set(self, task_id, subject=None, desc=None, status=None):
        if task_id is None:
            return
        dkey = 'task:%s:%s:%s' % (self.sid, self.agent_key(), task_id)
        if status == 'deleted':
            self.ix.delete_dkey(dkey)
            return
        patch = {'taskId': str(task_id)}
        if subject:
            patch['subject'] = one_line(subject, 300)
        if desc:
            patch['description'] = one_line(desc, 400)
        if status:
            patch['status'] = status
        bufdoc, row = self.ix.lookup(dkey)
        if bufdoc is None and row is None:
            if not subject:
                return  # an update for a task we never saw created
            patch.setdefault('status', 'pending')
        self.upsert(dkey, 'task', 'assistant', patch,
                    lambda e: (e.get('subject') or '') + ('\n' + e['description'] if e.get('description') else ''))

    def decision(self, text: str, via: str):
        self.doc('decision', text, 'user', extra={'via': via}, chunk=False, cap=800)

    # -- git / GitHub -------------------------------------------------------------------------
    def vcs(self, cmd: str, out: str, git: dict | None, is_err: bool):
        if git and not is_err:
            c = git.get('commit')
            if isinstance(c, dict) and c.get('sha'):
                msg = commit_message(cmd) or self._commit_msg_from_out(out, c['sha'])
                self.commit(c['sha'], msg, c.get('branch'), c.get('kind'))
            pr = git.get('pr')
            if isinstance(pr, dict) and pr.get('number'):
                mpr = _GH_PR_CREATE_RE.search(cmd)
                title = option_value(cmd, mpr.end(), ('--title', '-t')) if mpr else ''
                url = pr.get('url') or ''
                repo = None
                m = _PR_URL_RE.search(url)
                if m:
                    repo = m.group(1)
                self.pr(pr.get('number'), url, repo, title, pr.get('action'))
        if is_err:
            return
        if 'commit' in cmd and _COMMIT_CMD_RE.search(cmd) and '--dry-run' not in cmd and 'nothing to commit' not in out \
                and 'no changes added to commit' not in out and not (git and git.get('commit')):
            msg = commit_message(cmd)
            lines = _COMMIT_LINE_RE.findall(out)
            if lines:
                for branch, sha_, subject in lines[:5]:
                    full = msg if (msg and msg.split('\n', 1)[0].strip() == subject.strip()) else (msg or subject)
                    self.commit(sha_, full, branch, None)
            elif msg:
                subject = msg.split('\n', 1)[0].strip()
                found = None
                for sha_, rest in _SHA_LINE_RE.findall(out):
                    if rest and subject and (rest.strip().startswith(subject[:40]) or subject.startswith(rest.strip()[:40])):
                        found = sha_
                        break
                self.commit(found, msg, None, None)
        m = _GH_PR_CREATE_RE.search(cmd) if 'gh ' in cmd else None
        if m:
            title = option_value(cmd, m.end(), ('--title', '-t'))
            for repo, num in _PR_URL_RE.findall(out)[:3]:
                self.pr(int(num), 'https://github.com/%s/pull/%s' % (repo, num), repo, title, 'created')
        m = _GH_ISSUE_CREATE_RE.search(cmd) if 'gh ' in cmd else None
        if m:
            title = option_value(cmd, m.end(), ('--title', '-t'))
            for repo, num in _ISSUE_URL_RE.findall(out)[:3]:
                self.issue(int(num), 'https://github.com/%s/issues/%s' % (repo, num), repo, title)

    @staticmethod
    def _commit_msg_from_out(out: str, sha_: str) -> str:
        for branch, s, subject in _COMMIT_LINE_RE.findall(out or ''):
            if s.startswith(sha_[:7]) or sha_.startswith(s[:7]):
                return subject
        for s, rest in _SHA_LINE_RE.findall(out or ''):
            if rest and (s.startswith(sha_[:7]) or sha_.startswith(s[:7])):
                return rest
        return ''

    def commit(self, sha_, message, branch, kind):
        sha_ = (sha_ or '').strip() or None
        message = (message or '').strip()
        if not sha_ and not message:
            return
        dkey = 'commit:%s:%s' % (self.sid, sha_[:7] if sha_ else 'm' + sha(message))
        extra = {'sha': sha_[:12] if sha_ else None, 'message': clip(message, 1500), 'branch': branch, 'kind': kind}
        self.upsert(dkey, 'commit', 'assistant', extra,
                    lambda e: (e.get('message') or '') or ('commit ' + (e.get('sha') or '')))

    def pr(self, number, url, repo, title, action):
        try:
            number = int(number)
        except (TypeError, ValueError):
            return
        if not repo and url:
            m = _PR_URL_RE.search(url)
            repo = m.group(1) if m else None
        dkey = 'pr:%s:%s#%s' % (self.sid, repo or '', number)
        extra = {'number': number, 'url': url or None, 'repo': repo, 'title': one_line(title, 300) or None}
        if action:
            extra['action'] = action
        self.upsert(dkey, 'pr', 'assistant', extra, _ref_text('PR'))

    def issue(self, number, url, repo, title):
        dkey = 'issue:%s:%s#%s' % (self.sid, repo or '', number)
        extra = {'number': number, 'url': url, 'repo': repo, 'title': one_line(title, 300) or None}
        self.upsert(dkey, 'issue', 'assistant', extra, _ref_text('Issue'))


def _patch(old: dict, new: dict) -> dict:
    out = dict(old or {})
    for k, v in (new or {}).items():
        if v is None or v == '' or v == []:
            continue
        out[k] = v
    return out


def _count_edits(old: dict, new: dict) -> dict:
    out = _patch(old, new)
    out['edits'] = int((old or {}).get('edits') or 0) + int((new or {}).get('edits') or 0)
    return out


def _ref_text(label):
    def make(e):
        head = '%s #%s' % (label, e.get('number'))
        if e.get('title'):
            head += ': ' + e['title']
        if e.get('repo'):
            head += ' (%s)' % e['repo']
        if e.get('url'):
            head += '\n' + e['url']
        return head
    return make


_TYPE_FIRST_RE = _Lazy(rb'^\{"type":"([a-z_-]+)"')
_TOOL_RESULT_MARK = b'"content":[{"tool_use_id":"'
_CLAUDE_TOP_TYPES = frozenset((b'custom-title', b'agent-name', b'ai-title', b'summary', b'pr-link', b'queue-operation',
                               b'user', b'assistant', b'system', b'attachment'))


class ClaudeParser(Parser):
    source = 'claude'

    def wants(self, line: bytes) -> bool:
        """Cheap byte-level test: False for records that cannot produce a doc (bookkeeping records,
        attachments other than queued prompts, tool results nobody is waiting for)."""
        if line.startswith(b'{"type":"'):
            m = _TYPE_FIRST_RE.match(line)
            return not m or m.group(1) in _CLAUDE_TOP_TYPES
        a = line.find(b'"attachment":{"type":"', 0, 600)
        if a >= 0:
            return line.startswith(b'queued_command"', a + 22)
        i = line.find(_TOOL_RESULT_MARK, 0, 4000)
        if i >= 0:
            j = i + len(_TOOL_RESULT_MARK)
            k = line.find(b'"', j, j + 200)
            if k > 0 and line[j:k].decode('ascii', 'replace') not in self.pending \
                    and line.find(b'"tool_use_id":"', k) < 0:
                return False
        return True

    def __init__(self, ix, frow, state):
        super().__init__(ix, frow, state)
        self.track_uuids = not self.is_sub
        self.known = {}
        self.new_uuids = []

    def known_uuids(self, sid):
        s = self.known.get(sid)
        if s is None:
            s = set(r[0] for r in self.ix.con.execute(
                'SELECT uuid FROM uuids WHERE session_id=? AND file_id!=?', (sid, self.file_id)))
            self.known[sid] = s
        return s

    def handle(self, r: dict):
        t = r.get('type')
        sid = r.get('sessionId') or r.get('session_id')
        if sid and not self.is_sub:
            self.sid = sid
        ts = ts_ms(r.get('timestamp'))
        if t in ('user', 'assistant', 'attachment', 'system'):
            if not (r.get('isSidechain') and not self.is_sub):
                self.see_cwd(r.get('cwd'), ts)  # before dedupe: a copy still sees the session's first cwd
            uuid = r.get('uuid')
            if uuid and self.track_uuids and self.sid:
                known = self.known_uuids(self.sid)
                if uuid in known:
                    if t == 'assistant':
                        self.register_known(r)  # its tool results may only be in this copy
                    return
                known.add(uuid)
                self.new_uuids.append((self.sid, uuid, self.file_id))
            self.ref = uuid
            self.see_ts(ts)
            if r.get('isSidechain') and not self.is_sub:
                if not self.ix.subagents:
                    self.state['sideSkipped'] = True  # re-read once --subagents is passed
                    return
                self.see_cwd(r.get('cwd'), ts)
            b = r.get('gitBranch')
            if b and b != 'HEAD':
                self.set_meta('branch', b, ts)
            if r.get('entrypoint'):
                self.set_meta('entry', r.get('entrypoint'), ts)
            side = bool(r.get('isSidechain')) and not self.is_sub
            if side:
                was = self.is_sub
                self.is_sub = True
                try:
                    self.dispatch(t, r)
                finally:
                    self.is_sub = was
            else:
                self.dispatch(t, r)
            return
        if ts:
            self.see_ts(ts)
        if t == 'custom-title':
            self.set_meta('custom', one_line(r.get('customTitle') or '', 300), ts or self.ts)
        elif t == 'agent-name':
            if not self.is_sub:
                self.set_meta('agentName', one_line(r.get('agentName') or '', 300), ts or self.ts)
        elif t == 'ai-title':
            self.set_meta('ai', one_line(r.get('aiTitle') or '', 300), ts or self.ts)
        elif t == 'summary' and isinstance(r.get('summary'), str) and not self.is_sub:
            self.set_meta('ai', one_line(r['summary'], 300), ts or self.ts)  # older Claude Code session titles
        elif t == 'pr-link':
            n = r.get('prNumber')
            url = r.get('prUrl') or ''
            key = 'prlink:%s:%s' % (n, url)
            seen = self.state.setdefault('prlinks', [])
            if key in seen:
                return
            seen.append(key)
            del seen[:-50]
            self.ref = None
            self.pr(n, url, r.get('prRepository'), None, None)
        elif t == 'queue-operation':
            c = r.get('content')
            if isinstance(c, str) and '<scheduled-task' in c and not self.is_sub:
                name = scheduled_task_name(c)
                if name:
                    self.meta['routine'] = name

    def dispatch(self, t, r):
        if t == 'user':
            self.on_user(r)
        elif t == 'assistant':
            self.on_assistant(r)
        elif t == 'attachment':
            a = r.get('attachment') or {}
            if a.get('type') == 'queued_command':
                mode = a.get('commandMode')
                origin = a.get('origin') if isinstance(a.get('origin'), dict) else {}
                if mode not in (None, 'prompt') or origin.get('kind') not in (None, 'human'):
                    if mode == 'task-notification' or origin.get('kind') == 'task-notification':
                        p = a.get('prompt')
                        if isinstance(p, str):
                            self.notifications(p)
                    return
                p = a.get('prompt')
                text = p if isinstance(p, str) else _blocks_text(p)
                if text.lstrip().startswith(('<task-notification', '<agent-message')):
                    if '<task-notification' in text:
                        self.notifications(text)
                    return
                self.human(text)

    def on_user(self, r):
        if r.get('isMeta'):
            return
        msg = r.get('message') or {}
        content = msg.get('content')
        if r.get('isCompactSummary'):
            text = content if isinstance(content, str) else _blocks_text(content)
            self.summary(text)
            return
        texts = []
        if isinstance(content, list):
            results = False
            for b in content:
                if not isinstance(b, dict):
                    continue
                bt = b.get('type')
                if bt == 'tool_result':
                    results = True
                    self.on_tool_result(r, b)
                elif bt == 'text':
                    texts.append(b.get('text') or '')
            if results:
                return
            text = '\n\n'.join(x for x in texts if x)
        elif isinstance(content, str):
            text = content
        else:
            return
        origin = r.get('origin') if isinstance(r.get('origin'), dict) else {}
        okind = origin.get('kind')
        if okind and okind != 'human':
            if okind == 'task-notification' and '<task-notification' in text:
                self.notifications(text)
            return
        stripped = text.lstrip()
        if stripped.startswith('<agent-message') or stripped.startswith('<ci-monitor-event'):
            return
        self.human(text)

    def on_assistant(self, r):
        if r.get('isApiErrorMessage'):
            return
        content = (r.get('message') or {}).get('content')
        if isinstance(content, str):
            content = [{'type': 'text', 'text': content}]
        if not isinstance(content, list):
            return
        for b in content:
            if not isinstance(b, dict):
                continue
            bt = b.get('type')
            if bt == 'text':
                self.answer(b.get('text') or '')
            elif bt == 'tool_use':
                self.on_tool_use(b)

    def on_tool_use(self, b):
        name = b.get('name') or ''
        inp = b.get('input') if isinstance(b.get('input'), dict) else {}
        tid = b.get('id')
        if name == 'Bash':
            cmd = inp.get('command')
            if not isinstance(cmd, str):
                return
            dkey = self.command(cmd, inp.get('description'), tid)
            if tid:
                self.remember(tid, self.pending_info(name, inp, dkey))
        elif name in ('Edit', 'Write', 'NotebookEdit', 'MultiEdit'):
            self.file_touch(inp.get('file_path') or inp.get('notebook_path'), name)
        elif name == 'WebFetch':
            url = inp.get('url')
            if isinstance(url, str) and url:
                prompt = one_line(inp.get('prompt') or '', 300)
                self.url(url + ('\n' + prompt if prompt else ''), {'url': url, 'tool': 'WebFetch'})
        elif name == 'WebSearch':
            q = inp.get('query')
            if isinstance(q, str) and q.strip():
                self.url(q, {'query': q, 'tool': 'WebSearch'})
        elif name == 'TaskCreate':
            if tid:
                self.remember(tid, self.pending_info(name, inp, None))
        elif name == 'TaskUpdate':
            self.task_set(inp.get('taskId'), inp.get('subject'), inp.get('description'), inp.get('status'))
        elif name == 'TodoWrite':
            todos = inp.get('todos')
            if isinstance(todos, list):
                self.todo_list([(t.get('content') or t.get('activeForm') or '', t.get('status'))
                                for t in todos if isinstance(t, dict)])
        elif name == 'AskUserQuestion':
            if tid:
                self.remember(tid, {'n': 'Ask'})

    def register_known(self, r):
        content = (r.get('message') or {}).get('content')
        if not isinstance(content, list):
            return
        for b in content:
            if isinstance(b, dict) and b.get('type') == 'tool_use' and b.get('id'):
                info = self.pending_info(b.get('name') or '', b.get('input') if isinstance(b.get('input'), dict) else {},
                                         'cmd:%s:%s' % (self.sid, b['id']))
                if info:
                    self.remember(b['id'], info)

    @staticmethod
    def pending_info(name, inp, dkey):
        if name == 'Bash' and isinstance(inp.get('command'), str):
            return {'n': 'Bash', 'c': mask_secrets(inp['command'][:20000]), 'k': dkey}
        if name == 'TaskCreate':
            return {'n': 'TaskCreate', 's': mask_secrets(one_line(inp.get('subject') or '', 300)),
                    'd': mask_secrets(one_line(inp.get('description') or '', 400))}
        if name == 'AskUserQuestion':
            return {'n': 'Ask'}
        return None

    def remember(self, tid, info):
        self.pending[tid] = info
        if len(self.pending) > 300:
            for k in list(self.pending)[:len(self.pending) - 300]:
                del self.pending[k]

    def on_tool_result(self, r, b):
        tid = b.get('tool_use_id')
        p = self.pending.pop(tid, None) if tid else None
        if not p:
            return
        is_err = bool(b.get('is_error'))
        tur = r.get('toolUseResult')
        content = b.get('content')
        ctext = content if isinstance(content, str) else _blocks_text(content)
        n = p.get('n')
        if n == 'Bash':
            out, err, git, interrupted = ctext, '', None, False
            if isinstance(tur, dict):
                out = tur.get('stdout') or ''
                err = tur.get('stderr') or ''
                git = tur.get('gitOperation')
                interrupted = bool(tur.get('interrupted'))
            code = None
            m = re.match(r'(?:Error: )?Exit code (\d+)', ctext or '')
            if m:
                code = int(m.group(1))
            if is_err:
                snippet = err or re.sub(r'^(?:Error: )?Exit code \d+\s*', '', ctext or '')
                self.command_result(p, snippet, True, code, git, interrupted)
            else:
                self.command_result(p, out + ('\n' + err if err else ''), False, code, git, interrupted)
        elif n == 'TaskCreate':
            task = tur.get('task') if isinstance(tur, dict) else None
            tid2 = task.get('id') if isinstance(task, dict) else None
            if tid2 is None:
                m = re.search(r'Task #?(\w+)', ctext or '')
                tid2 = m.group(1) if m else None
            if tid2 is not None and not is_err:
                self.task_set(tid2, p.get('s') or (task or {}).get('subject'), p.get('d'), 'pending')
        elif n == 'Ask':
            answers = tur.get('answers') if isinstance(tur, dict) else None
            if isinstance(answers, dict) and not is_err:
                for q, a in list(answers.items())[:6]:
                    if isinstance(a, list):
                        a = ', '.join(str(x) for x in a)
                    if not a:
                        continue
                    self.decision('Q: %s → A: %s' % (one_line(q, 300), one_line(str(a), 300)), 'question')


def _blocks_text(blocks) -> str:
    if isinstance(blocks, str):
        return blocks
    if not isinstance(blocks, list):
        return ''
    out = []
    for b in blocks:
        if isinstance(b, dict) and b.get('type') in ('text', 'input_text', 'output_text'):
            out.append(b.get('text') or '')
        elif isinstance(b, str):
            out.append(b)
    return '\n\n'.join(x for x in out if x)


_CODEX_CONTEXT_HEADS = ('# AGENTS.md instructions', '# Context from my IDE setup', '# Files mentioned by the user',
                        '# In app browser', '# Review findings')
_WRAPPED_BLOCK_RE = _Lazy(r'^<([A-Za-z_][\w-]*)\b[^>]*>[\s\S]*</\1\s*>$')
_CODEX_REQUEST_RE = _Lazy(r'^##\s*My request for Codex:\s*$', re.M)
_EXIT_RE = _Lazy(r'Process exited with code (-?\d+)')
_JS_CMD_RE = _Lazy(r'\bexec_command\(\s*\{\s*cmd\s*:\s*("(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|`(?:[^`\\]|\\.)*`)')
_PATCH_FILE_RE = _Lazy(r'^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$', re.M)


def codex_user_text(blocks) -> str:
    out = []
    if isinstance(blocks, str):
        blocks = [{'type': 'input_text', 'text': blocks}]
    for b in blocks or []:
        if not isinstance(b, dict) or b.get('type') not in ('input_text', 'text'):
            continue
        t = (b.get('text') or '').strip()
        if not t:
            continue
        m = _CODEX_REQUEST_RE.search(t)
        if m:
            t = t[m.end():].strip()
        elif t.startswith(_CODEX_CONTEXT_HEADS):
            continue
        if _WRAPPED_BLOCK_RE.match(t) or (t.startswith('<') and t.endswith('>') and '\n' not in t):
            continue
        if t:
            out.append(t)
    return '\n\n'.join(out)


def _js_string(lit: str) -> str:
    q = lit[0]
    body = lit[1:-1]
    if q == '"':
        try:
            return json.loads(lit)
        except ValueError:
            pass
    return re.sub(r'\\(.)', lambda m: {'n': '\n', 't': '\t'}.get(m.group(1), m.group(1)), body)


_CODEX_HEAD_RE = _Lazy(rb'"type":"([a-z_]+)"(?:,"payload":\{"type":"([a-z_]+)")?')
_CODEX_CALL_RE = _Lazy(rb'"call_id":"([^"]{1,200})"')
_CODEX_SKIP_TYPES = frozenset((b'event_msg', b'token_usage_record', b'world_state',
                               b'inter_agent_communication_metadata'))
_CODEX_SKIP_PAYLOADS = frozenset((b'reasoning', b'tool_search_call', b'tool_search_output', b'compaction'))


class CodexParser(Parser):
    source = 'codex'

    def wants(self, line: bytes) -> bool:
        m = _CODEX_HEAD_RE.search(line, 0, 300)
        if not m:
            return True
        t, pt = m.group(1), m.group(2)
        if t in _CODEX_SKIP_TYPES:
            return False
        if t == b'response_item' and pt:
            if pt in _CODEX_SKIP_PAYLOADS:
                return False
            if pt in (b'function_call_output', b'custom_tool_call_output'):
                c = _CODEX_CALL_RE.search(line, m.end(), m.end() + 300)
                if c and c.group(1).decode('ascii', 'replace') not in self.pending:
                    return False
        return True

    def handle(self, r: dict):
        t = r.get('type')
        p = r.get('payload') if isinstance(r.get('payload'), dict) else {}
        ts = ts_ms(r.get('timestamp'))
        if t == 'session_meta':
            self.on_meta(p, ts)
            return
        if self.state.get('skip') or not self.sid:
            return
        self.see_ts(ts)
        if t == 'turn_context':
            self.see_cwd(p.get('cwd'), ts)
            return
        if t == 'compacted':
            msg = p.get('message')
            if isinstance(msg, str) and len(msg.strip()) > 40:
                self.ref = 'L%s' % self.state.get('_offset', 0)
                self.summary(msg)
            return
        if t != 'response_item':
            return
        pt = p.get('type')
        self.ref = p.get('id') or 'L%s' % self.state.get('_offset', 0)
        if pt == 'message':
            role = p.get('role')
            if role == 'user':
                text = codex_user_text(p.get('content'))
                if text:
                    self.human(text)
            elif role == 'assistant':
                self.answer(_blocks_text(p.get('content')))
        elif pt == 'function_call':
            name = p.get('name') or ''
            args = loads(p.get('arguments'), {}) if isinstance(p.get('arguments'), str) else (p.get('arguments') or {})
            if not isinstance(args, dict):
                args = {}
            self.on_call(name, args, p.get('call_id'))
        elif pt == 'local_shell_call':
            action = p.get('action') or {}
            cmd = action.get('command')
            self.on_call('shell', {'command': cmd, 'workdir': action.get('working_directory')}, p.get('call_id'))
        elif pt == 'custom_tool_call':
            name = p.get('name') or ''
            inp = p.get('input') or ''
            if name == 'apply_patch':
                self.on_patch(inp)
            elif name == 'exec' and isinstance(inp, str):
                for lit in _JS_CMD_RE.findall(inp)[:10]:
                    cmd = _js_string(lit)
                    self.command(cmd, None, None)
            else:
                self.on_call(name, loads(inp, {}) if isinstance(inp, str) else {}, p.get('call_id'))
        elif pt in ('function_call_output', 'custom_tool_call_output'):
            self.on_output(p.get('call_id'), p.get('output'))
        elif pt == 'web_search_call':
            action = p.get('action') or {}
            q = action.get('query') or (action.get('queries') or [None])[0]
            if isinstance(q, str) and q.strip():
                self.url(q, {'query': q, 'tool': 'web_search'})
            elif isinstance(action.get('url'), str):
                self.url(action['url'], {'url': action['url'], 'tool': 'web_search'})

    def on_meta(self, p, ts):
        if self.sid and self.state.get('metaSeen'):
            return
        self.state['metaSeen'] = True
        sid = p.get('id') or p.get('session_id')
        src = p.get('source')
        if isinstance(src, dict) and 'subagent' in src:
            sa = src.get('subagent')
            spawn = sa.get('thread_spawn') if isinstance(sa, dict) else None
            if not isinstance(spawn, dict):
                self.state['skip'] = 'never'  # guardian / approval-review threads
                return
            if not self.ix.subagents:
                self.state['skip'] = 'subagents'  # picked up once --subagents is passed
                return
            parent = spawn.get('parent_thread_id') or p.get('parent_thread_id')
            if not parent:
                self.state['skip'] = 'never'
                return
            self.is_sub = True
            self.state['isSub'] = True
            self.agent = p.get('agent_nickname') or p.get('agent_path') or sid
            self.state['agent'] = self.agent
            self.state['agentName'] = mask_secrets(str(spawn.get('agent_nickname') or p.get('agent_nickname')
                                                       or p.get('agent_path') or ''))
            sid = parent
        if not sid:
            self.state['skip'] = 'never'
            return
        self.sid = sid
        self.state['sid'] = sid
        if self.is_sub:
            self.inherit_parent()
        self.see_ts(ts or ts_ms(p.get('timestamp')))
        self.see_cwd(p.get('cwd'), self.ts)
        git = p.get('git') if isinstance(p.get('git'), dict) else {}
        if git.get('branch'):
            self.set_meta('branch', git['branch'], self.ts)
        if p.get('originator'):
            self.set_meta('entry', p.get('originator'), self.ts)
        titles = self.ix.codex_titles or {}
        if not self.is_sub and sid in titles:
            self.set_meta('codexTitle', titles[sid][1], titles[sid][0])

    def on_call(self, name, args, call_id):
        cmd, wd = None, None
        if name in ('exec_command', 'shell_command'):
            cmd = args.get('cmd') or args.get('command')
            wd = args.get('workdir')
        elif name in ('shell', 'container.exec', 'local_shell'):
            c = args.get('command')
            if isinstance(c, list):
                if len(c) >= 3 and os.path.basename(str(c[0])) in ('bash', 'zsh', 'sh') and c[1] in ('-lc', '-c'):
                    cmd = c[2]
                else:
                    import shlex
                    cmd = ' '.join(shlex.quote(str(x)) for x in c)
            elif isinstance(c, str):
                cmd = c
            wd = args.get('workdir')
        elif name == 'update_plan':
            plan = args.get('plan')
            if isinstance(plan, list):
                self.todo_list([(s.get('step') or '', s.get('status')) for s in plan if isinstance(s, dict)])
            return
        elif name == 'apply_patch':
            self.on_patch(args.get('input') or args.get('patch') or '')
            return
        if isinstance(cmd, list):
            cmd = ' '.join(str(x) for x in cmd)
        if isinstance(cmd, str) and cmd.strip():
            if isinstance(wd, str) and wd:
                self.see_cwd(wd, self.ts)
            dkey = self.command(cmd, args.get('justification') if isinstance(args.get('justification'), str) else None,
                                call_id)
            if call_id:
                self.pending[call_id] = {'n': 'Bash', 'c': mask_secrets(cmd[:20000]), 'k': dkey}
                if len(self.pending) > 300:
                    for k in list(self.pending)[:len(self.pending) - 300]:
                        del self.pending[k]

    def on_patch(self, patch):
        if not isinstance(patch, str):
            return
        cwd = (self.meta.get('cwd') or [0, None])[1]
        for a, b in _PATCH_FILE_RE.findall(patch)[:50]:
            path = (a or b).strip()
            if path and not os.path.isabs(path) and cwd:
                path = os.path.normpath(os.path.join(cwd, path))
            self.file_touch(path, 'apply_patch')

    def on_output(self, call_id, output):
        p = self.pending.pop(call_id, None) if call_id else None
        if not p:
            return
        text = output if isinstance(output, str) else _blocks_text(output)
        code = None
        if text.startswith('{'):
            obj = loads(text, None)
            if isinstance(obj, dict):
                md = obj.get('metadata') if isinstance(obj.get('metadata'), dict) else {}
                if isinstance(md.get('exit_code'), int):
                    code = md['exit_code']
                text = obj.get('output') if isinstance(obj.get('output'), str) else text
        m = _EXIT_RE.search(text[:400])
        if m:
            code = int(m.group(1))
        body = text
        k = text.find('Output:\n')
        if k >= 0 and k < 600:
            body = text[k + 8:]
        is_err = code is not None and code != 0
        self.command_result(p, body, is_err, code)


# --------------------------------------------------------------------------------------------
# Update

def _stat(path):
    try:
        st = os.stat(path)
        return st.st_size, st.st_mtime
    except OSError:
        return None


def discover(home: str, sources: set, subagents: bool) -> list:
    """(path, source, kind) for every file of the given sources."""
    out = []
    projects = os.path.join(home, '.claude', 'projects')
    if ('claude' in sources or 'memory' in sources) and os.path.isdir(projects):
        for proj in sorted(os.listdir(projects)):
            pdir = os.path.join(projects, proj)
            if not os.path.isdir(pdir):
                continue
            try:
                entries = sorted(os.listdir(pdir))
            except OSError:
                continue
            for e in entries:
                p = os.path.join(pdir, e)
                if e.endswith('.jsonl') and 'claude' in sources:
                    if os.path.isfile(p):
                        out.append((p, 'claude', 'main'))
                elif e == 'memory' and 'memory' in sources:
                    try:
                        for m in sorted(os.listdir(p)):
                            if m.endswith('.md') and os.path.isfile(os.path.join(p, m)):
                                out.append((os.path.join(p, m), 'memory', 'memory'))
                    except OSError:
                        pass
                elif subagents and 'claude' in sources and os.path.isdir(p):
                    sub = os.path.join(p, 'subagents')
                    if os.path.isdir(sub):
                        for root, dirs, files in os.walk(sub):
                            dirs.sort()
                            for n in sorted(files):
                                if n.startswith('agent-') and n.endswith('.jsonl'):
                                    out.append((os.path.join(root, n), 'claude', 'sub'))
    if 'codex' in sources:
        for base in (os.path.join(home, '.codex', 'sessions'), os.path.join(home, '.codex', 'archived_sessions')):
            if os.path.isdir(base):
                for root, dirs, files in os.walk(base):
                    dirs.sort()
                    for n in sorted(files):
                        if n.endswith('.jsonl'):
                            out.append((os.path.join(root, n), 'codex', 'main'))
    if 'orders' in sources:
        d = os.path.join(home, '.claude', 'standing-orders')
        if os.path.isdir(d):
            for n in sorted(os.listdir(d)):
                if n.endswith('.json') and os.path.isfile(os.path.join(d, n)):
                    out.append((os.path.join(d, n), 'orders', 'orders'))
    if 'reviews' in sources:
        d = os.path.join(home, '.claude', 'second-opinions')
        if os.path.isdir(d):
            for proj in sorted(os.listdir(d)):
                pd = os.path.join(d, proj)
                if os.path.isdir(pd):
                    for n in sorted(os.listdir(pd)):
                        if n.endswith('.md') and os.path.isfile(os.path.join(pd, n)):
                            out.append((os.path.join(pd, n), 'reviews', 'reviews'))
    return out


_B64_RE = _Lazy(rb'"(data|image_url|base64|bytes)"\s*:\s*"(?:data:[^",]{0,80},)?[A-Za-z0-9+/=\\\r\n]{2000,}"')


def _parse_line(line: bytes):
    if len(line) > BIG_LINE and (b'base64' in line or b'"data"' in line):
        line = _B64_RE.sub(rb'"\1":""', line)
    if len(line) > HUGE_LINE:
        return None
    try:
        r = json.loads(line)
    except ValueError:
        return None
    return r if isinstance(r, dict) else None


_FILE_FIELDS = ('id', 'path', 'source', 'kind', 'size', 'mtime', 'offset', 'head_len', 'head_hash', 'session_id',
                'project', 'agent', 'agent_name', 'skipped', 'transcript_exists', 'min_ts', 'max_ts', 'state', 'fmt')


class Updater:
    def __init__(self, con, db_path, home, args):
        self.con = con
        self.db_path = db_path
        self.home = home
        self.args = args
        self.ix = Indexer(con, home, bool(args.subagents))
        self.partial = False
        self.deadline = (time.time() + args.max_seconds) if args.max_seconds is not None else None
        self.bytes_total = 0
        self.bytes_done = 0
        self.files_total = 0
        self.files_done = 0
        self.last_progress = 0.0
        self.files_changed = 0
        self.errors = 0
        self.requeue = []
        self.reset_done = set()
        self.in_tx = False
        self.tx_t0 = 0.0
        self.tx_bytes = 0
        self.tx_docs = 0

    # Many small transactions make FTS5 flush and merge many tiny segments, so files share one
    # transaction (a savepoint each) that commits every ~64 MB, 30k docs or 8 seconds.
    def begin(self):
        if not self.in_tx:
            self.con.execute('BEGIN IMMEDIATE')
            self.in_tx = True
            self.tx_t0 = time.time()
            self.tx_bytes = 0
            self.tx_docs = self.ix.added

    def maybe_commit(self, force=False):
        if self.in_tx and (force or self.tx_bytes > 64 * 1024 * 1024 or self.ix.added - self.tx_docs > 30000
                           or time.time() - self.tx_t0 > 8):
            self.ix.flush()
            self.con.execute('COMMIT')
            self.in_tx = False

    def progress(self, force=False):
        if not self.args.progress:
            return
        now = time.time()
        if force or now - self.last_progress >= 0.5:
            self.last_progress = now
            sys.stderr.write(dumps({'progress': {'files_done': self.files_done, 'files_total': self.files_total,
                                                 'bytes_done': self.bytes_done, 'bytes_total': self.bytes_total}}) + '\n')
            sys.stderr.flush()

    def out_of_time(self):
        if self.deadline and time.time() > self.deadline:
            self.partial = True
            return True
        return False

    def run(self, sources: set):
        con = self.con
        t0 = time.time()
        ix = self.ix
        if 'codex' in sources:
            ix.codex_titles = self.codex_titles()
        found = discover(self.home, sources, bool(self.args.subagents))
        rows = {}
        for r in con.execute('SELECT id, path, source, kind, size, mtime, offset, head_len, head_hash, session_id, '
                             'project, agent, agent_name, skipped, transcript_exists, min_ts, max_ts, state, fmt '
                             'FROM files'):
            rows[r[1]] = dict(zip(_FILE_FIELDS, r))
        work = []
        seen = set()
        for path, source, kind in found:
            seen.add(path)
            st = _stat(path)
            if st is None:
                continue
            size, mtime = st
            row = rows.get(path)
            if row is not None and (self.args.rebuild or row['fmt'] < INDEX_FORMAT or (self.args.subagents and (
                    row['skipped'] == 2 or '"sideSkipped":true' in (row['state'] or '')))):
                work.append((path, source, kind, size, mtime, row, True))  # re-read from the start
                continue
            if row is None:
                work.append((path, source, kind, size, mtime, None, False))
            elif row['size'] != size or abs((row['mtime'] or 0) - mtime) > 1e-6 or not row['transcript_exists'] \
                    or (source in ('claude', 'codex') and row['offset'] < size and not row['skipped']):
                work.append((path, source, kind, size, mtime, row, False))
        # files that disappeared
        missing = [r for p, r in rows.items() if p not in seen and r['source'] in sources
                   and (r['kind'] != 'sub' or self.args.subagents)]
        with Tx(con):
            for r in missing:
                if r['source'] in ('memory', 'orders', 'reviews') or self.args.prune_deleted:
                    ix.delete_file_docs(r['id'])
                    con.execute('DELETE FROM files WHERE id=?', (r['id'],))
                    if r['session_id']:
                        ix.touched.add(r['session_id'])
                else:
                    if r['transcript_exists']:
                        con.execute('UPDATE files SET transcript_exists=0 WHERE id=?', (r['id'],))
                    if r['fmt'] < INDEX_FORMAT:  # cannot be re-read: bring its docs up to date in place
                        self.fixup_docs(r['id'])
                        con.execute('UPDATE files SET fmt=? WHERE id=?', (INDEX_FORMAT, r['id']))
                    if r['session_id']:
                        ix.touched.add(r['session_id'])
        order = {'main': 0, 'sub': 1, 'memory': 2, 'orders': 3, 'reviews': 3}
        work.sort(key=lambda w: (0 if w[1] == 'claude' else 1 if w[1] == 'codex' else 2, order.get(w[2], 4), -w[4]))
        self.files_total = len(work)
        self.bytes_total = sum(max(0, w[3] - ((w[5] or {}).get('offset') or 0)) for w in work)
        self.progress(force=True)
        reread = [w[5]['id'] for w in work if w[6] and w[5] is not None]
        if reread:
            self.bulk_reset(reread)
        i = 0
        while i < len(work):
            path, source, kind, size, mtime, row, rebuild = work[i]
            i += 1
            if self.out_of_time():
                break
            try:
                row = self.file_row(path)  # current, not the snapshot taken when the work list was made
                if row is not None and row['id'] in self.reset_done:
                    rebuild = False  # never reset the same file twice in one run
                if source in ('claude', 'codex'):
                    self.index_transcript(path, source, kind, size, mtime, row, rebuild)
                else:
                    self.index_small(path, source, kind, size, mtime, row)
            except Exception as e:  # one bad file must not stop the rest
                self.errors += 1
                sys.stderr.write('recall: skipped %s: %s: %s\n' % (path, type(e).__name__, e))
            self.files_done += 1
            self.progress()
            self.maybe_commit()
            # sibling copies of a shrunk or rewritten session were reset to re-read from the start
            while self.requeue:
                sib = self.requeue.pop()
                st = _stat(sib)
                srow = self.file_row(sib)
                if st and srow:
                    work.append((sib, srow['source'], srow['kind'], st[0], st[1], srow, False))
                    self.files_total += 1
        self.maybe_commit(force=True)
        with Tx(con):
            for sid in sorted(ix.touched):
                ix.refresh_session(sid)
            ix.flush()
            if self.args.retention_days:
                cutoff = now_ms() - int(self.args.retention_days * DAY_MS)
                cur = con.execute("DELETE FROM docs WHERE ts>0 AND ts<? AND kind!='note'", (cutoff,))
                ix.removed += max(0, cur.rowcount)
                con.execute('DELETE FROM sessions WHERE last_ts<? AND session_id NOT IN '
                            '(SELECT DISTINCT session_id FROM docs WHERE session_id IS NOT NULL)', (cutoff,))
            if int(meta_get(con, 'index_format', 0) or 0) < INDEX_FORMAT and not self.partial:
                for (nid,) in con.execute('SELECT id FROM docs WHERE file_id IS NULL').fetchall():  # notes, titles
                    self.fix_doc(nid)
                if not con.execute('SELECT 1 FROM files WHERE fmt < ? LIMIT 1', (INDEX_FORMAT,)).fetchone():
                    meta_set(con, 'index_format', INDEX_FORMAT)
            meta_set(con, 'last_update', now_ms())
        self.progress(force=True)
        out = {'files': self.files_changed, 'docs_added': ix.added, 'docs_removed': ix.removed,
               'sessions': len(ix.touched), 'seconds': round(time.time() - t0, 2), 'partial': self.partial}
        if self.errors:
            out['errors'] = self.errors
        return out

    def bulk_reset(self, file_ids):
        """Clears the docs of files about to be re-read from the start (a format upgrade or --rebuild)
        in one pass: deleting row by row through the FTS triggers is several times slower."""
        con, ix = self.con, self.ix
        triggers = [st for st in _split_sql(SCHEMA) if st.startswith('CREATE TRIGGER IF NOT EXISTS docs_ad ')
                    or st.startswith('CREATE TRIGGER IF NOT EXISTS docs_text_ad ')]
        with Tx(con):
            con.execute('CREATE TEMP TABLE IF NOT EXISTS reset_ids(id INTEGER PRIMARY KEY)')
            con.execute('DELETE FROM reset_ids')
            con.executemany('INSERT OR IGNORE INTO reset_ids(id) VALUES (?)', [(f,) for f in file_ids])
            for (sid,) in con.execute('SELECT DISTINCT session_id FROM files WHERE id IN (SELECT id FROM reset_ids) '
                                      'AND session_id IS NOT NULL').fetchall():
                ix.touched.add(sid)
            con.execute('DROP TRIGGER IF EXISTS docs_ad')
            con.execute('DROP TRIGGER IF EXISTS docs_text_ad')
            con.execute('DELETE FROM docs_text WHERE id IN (SELECT id FROM docs WHERE file_id IN '
                        '(SELECT id FROM reset_ids))')
            cur = con.execute('DELETE FROM docs WHERE file_id IN (SELECT id FROM reset_ids)')
            ix.removed += max(0, cur.rowcount)
            con.execute('DELETE FROM uuids WHERE file_id IN (SELECT id FROM reset_ids)')
            con.execute('UPDATE files SET offset=0, head_len=0, state=NULL, min_ts=NULL, max_ts=NULL, skipped=0 '
                        'WHERE id IN (SELECT id FROM reset_ids)')
            for st in triggers:
                con.execute(st)
            con.execute("INSERT INTO docs_fts(docs_fts) VALUES ('rebuild')")  # from the docs_text that remain
            con.execute('DELETE FROM reset_ids')
        self.reset_done.update(file_ids)

    def file_row(self, path):
        r = self.con.execute('SELECT id, path, source, kind, size, mtime, offset, head_len, head_hash, session_id, '
                             'project, agent, agent_name, skipped, transcript_exists, min_ts, max_ts, state, fmt '
                             'FROM files WHERE path=?', (path,)).fetchone()
        return dict(zip(_FILE_FIELDS, r)) if r else None

    def fixup_docs(self, file_id):
        """Brings docs of a file that can no longer be re-read up to the current index format."""
        for (did,) in self.con.execute('SELECT id FROM docs WHERE file_id=?', (file_id,)).fetchall():
            self.fix_doc(did)

    def fix_doc(self, did):
        row = self.con.execute('SELECT d.kind, d.extra, d.flags, t.text, t.parts FROM docs d JOIN docs_text t '
                               'ON t.id = d.id WHERE d.id=?', (did,)).fetchone()
        if not row:
            return
        kind, extra, flags, text, parts = row
        new_parts = parts_of(text)
        if new_parts != parts:
            self.con.execute('UPDATE docs_text SET parts=? WHERE id=?', (new_parts, did))
        if kind == 'command':
            cmd = re.sub(r'\n# [^\n]*$', '', text)
            if is_inspection(cmd) and not flags & FLAG_INSPECT:
                e = loads(extra, {}) or {}
                e['inspect'] = True
                self.con.execute('UPDATE docs SET flags=flags|?, extra=? WHERE id=?', (FLAG_INSPECT, dumps(e), did))

    def codex_titles(self):
        titles = {}
        p = os.path.join(self.home, '.codex', 'session_index.jsonl')
        try:
            with open(p, 'rb') as fh:
                for line in fh:
                    r = _parse_line(line)
                    if r and r.get('id') and r.get('thread_name'):
                        t = ts_ms(r.get('updated_at')) or 0
                        if r['id'] not in titles or t >= titles[r['id']][0]:
                            titles[r['id']] = (t, one_line(r['thread_name'], 300))
        except OSError:
            pass
        return titles

    # -- transcripts (append-only JSONL) ------------------------------------------------------
    def index_transcript(self, path, source, kind, size, mtime, row, rebuild):
        con, ix = self.con, self.ix
        reset = rebuild
        changed = False  # the file shrank or its start changed (unlike a requested re-read)
        with open(path, 'rb') as fh:
            head = fh.read(1024)
        if row is not None and not reset:
            if row['skipped'] and source == 'codex' and row['fmt'] >= INDEX_FORMAT:
                self.begin()
                con.execute('UPDATE files SET size=?, mtime=?, offset=?, transcript_exists=1 WHERE id=?',
                            (size, mtime, size, row['id']))
                return
            if size < row['offset']:
                reset = changed = True
            elif row['head_len'] and sha_bytes(head[:row['head_len']]) != row['head_hash']:
                reset = changed = True
        self.files_changed += 1
        self.begin()
        con.execute('SAVEPOINT f')
        try:
            if row is None:
                parent = None
                agent = None
                agent_name = None
                if kind == 'sub':
                    parent = os.path.basename(path.split(os.sep + 'subagents' + os.sep)[0])
                    agent = os.path.basename(path)[len('agent-'):-len('.jsonl')]
                    agent_name = self.agent_name(path)
                elif source == 'claude':
                    parent = os.path.basename(path)[:-len('.jsonl')]
                cur = con.execute('INSERT INTO files(path, source, kind, size, mtime, offset, session_id, agent, agent_name, '
                                  'indexed_at, fmt) VALUES (?,?,?,?,?,0,?,?,?,?,?)',
                                  (path, source, kind, size, mtime, parent, agent, agent_name, now_ms(), INDEX_FORMAT))
                row = {'id': cur.lastrowid, 'path': path, 'source': source, 'kind': kind, 'offset': 0,
                       'session_id': parent, 'project': None, 'agent': agent, 'agent_name': agent_name,
                       'skipped': 0, 'min_ts': None, 'max_ts': None, 'state': None, 'head_len': 0, 'fmt': INDEX_FORMAT}
            if reset:
                ix.delete_file_docs(row['id'])
                self.reset_done.add(row['id'])
                if row.get('session_id'):
                    ix.touched.add(row['session_id'])
                if changed and row.get('session_id') and kind == 'main' and source == 'claude':
                    # records it held that its copies skipped as duplicates may be gone now: re-read the copies
                    sibs = con.execute("SELECT id, path FROM files WHERE session_id=? AND id!=? AND kind='main' "
                                       "AND source=? AND transcript_exists=1", (row['session_id'], row['id'], source)).fetchall()
                    for sib_id, sib_path in sibs:
                        ix.delete_file_docs(sib_id)
                        self.reset_done.add(sib_id)
                        con.execute('UPDATE files SET offset=0, head_len=0, state=NULL, min_ts=NULL, max_ts=NULL '
                                    'WHERE id=?', (sib_id,))
                        if sib_path not in self.requeue:
                            self.requeue.append(sib_path)
                row.update({'offset': 0, 'state': None, 'min_ts': None, 'max_ts': None, 'head_len': 0})
            state = loads(row.get('state'), {}) or {}
            frow = dict(row)
            if kind == 'sub' and source == 'claude':
                frow['agent'] = row.get('agent')
            parser = (ClaudeParser if source == 'claude' else CodexParser)(ix, frow, state)
            if source == 'codex' and state.get('isSub'):
                parser.is_sub = True
                parser.agent = state.get('agent')
            offset = row['offset'] or 0
            last_commit_bytes = 0
            n = 0
            with open(path, 'rb') as fh:
                fh.seek(offset)
                for line in fh:
                    if not line.endswith(b'\n'):
                        break
                    n += 1
                    ln = len(line)
                    state['_offset'] = offset
                    r = _parse_line(line) if parser.wants(line) else None
                    offset += ln
                    self.bytes_done += ln
                    self.tx_bytes += ln
                    last_commit_bytes += ln
                    if r is not None:
                        parser.handle(r)
                        if state.get('skip'):
                            offset = max(offset, size)
                            break
                    if n % 256 == 0:
                        if last_commit_bytes > 48 * 1024 * 1024 or len(ix.buf) > 20000:
                            self.checkpoint(parser, row, state, offset, size, mtime, head, final=False)
                            last_commit_bytes = 0
                        self.progress()
                        if self.out_of_time():
                            break
            self.checkpoint(parser, row, state, offset, size, mtime, head, final=True)
            con.execute('RELEASE f')
        except BaseException:
            con.execute('ROLLBACK TO f')
            con.execute('RELEASE f')
            ix.buf, ix.buf_keys, ix.seqs = [], {}, {}
            raise

    def checkpoint(self, parser, row, state, offset, size, mtime, head, final):
        con, ix = self.con, self.ix
        ix.flush()
        if isinstance(parser, ClaudeParser) and parser.new_uuids:
            con.executemany('INSERT OR IGNORE INTO uuids(session_id, uuid, file_id) VALUES (?,?,?)', parser.new_uuids)
            parser.new_uuids = []
        if parser.is_sub and state.get('last_answer') and state.get('last_answer') != state.get('marked_answer'):
            con.execute('UPDATE docs SET sub=1 WHERE file_id=? AND sub=2', (row['id'],))
            con.execute("UPDATE docs SET sub=2 WHERE file_id=? AND kind='answer' AND ref_uuid=?",
                        (row['id'], state['last_answer']))
            state['marked_answer'] = state['last_answer']
        state.pop('_offset', None)
        state['sid'] = parser.sid
        state['project'] = parser.project
        head_len = min(len(head), offset)
        sid = parser.sid
        skipped = (2 if state.get('skip') == 'subagents' else 1) if state.get('skip') else 0
        agent = row.get('agent')
        agent_name = row.get('agent_name')
        if parser.source == 'codex' and state.get('isSub'):
            agent = state.get('agent')
            agent_name = state.get('agentName') or agent
        con.execute('UPDATE files SET size=?, mtime=?, offset=?, head_len=?, head_hash=?, session_id=?, project=?, '
                    'skipped=?, transcript_exists=1, min_ts=?, max_ts=?, state=?, indexed_at=?, kind=?, agent=?, '
                    'agent_name=?, fmt=%d WHERE id=?' % INDEX_FORMAT,
                    (max(size, offset), mtime, offset, head_len,
                     sha_bytes(head[:head_len]), sid, parser.project, skipped, parser.min_ts,
                     parser.max_ts, dumps(state), now_ms(), 'sub' if parser.is_sub and parser.source == 'codex' else row['kind'],
                     agent, agent_name, row['id']))
        if sid and not skipped:
            ix.touched.add(sid)
        if not final:
            con.execute('RELEASE f')
            self.maybe_commit(force=True)
            self.begin()
            con.execute('SAVEPOINT f')

    @staticmethod
    def agent_name(path):
        name = Updater._agent_name(path)
        return mask_secrets(name) if name else name

    @staticmethod
    def _agent_name(path):
        meta = path[:-len('.jsonl')] + '.meta.json'
        try:
            with open(meta, 'rb') as fh:
                m = json.loads(fh.read(65536) or b'{}')
            if isinstance(m, dict):
                desc = m.get('description') or m.get('name')
                typ = m.get('agentType')
                if desc and typ and typ not in ('general-purpose', 'workflow-subagent'):
                    return clip('%s (%s)' % (desc, typ), 200)
                return clip(desc or typ or '', 200) or None
        except (OSError, ValueError):
            pass
        try:
            with open(path, 'rb') as fh:
                for _ in range(40):
                    line = fh.readline()
                    if not line:
                        break
                    r = _parse_line(line)
                    if r and r.get('type') == 'agent-name' and r.get('agentName'):
                        return clip(r['agentName'], 200)
                    if r and r.get('type') == 'user':
                        c = (r.get('message') or {}).get('content')
                        text = c if isinstance(c, str) else _blocks_text(c)
                        if text.strip():
                            return one_line(text.strip().split('\n', 1)[0], 80)
        except OSError:
            pass
        return None

    # -- memory / orders / reviews (rewritten in place) -------------------------------------
    def index_small(self, path, source, kind, size, mtime, row):
        con, ix = self.con, self.ix
        self.files_changed += 1
        with open(path, 'rb') as fh:
            raw = fh.read(512 * 1024)
        text = raw.decode('utf-8', 'replace')
        self.bytes_done += size
        self.begin()
        con.execute('SAVEPOINT f')
        try:
            self._index_small(path, source, kind, size, mtime, row, text)
            con.execute('RELEASE f')
        except BaseException:
            con.execute('ROLLBACK TO f')
            con.execute('RELEASE f')
            ix.buf, ix.buf_keys, ix.seqs = [], {}, {}
            raise

    def _index_small(self, path, source, kind, size, mtime, row, text):
        con, ix = self.con, self.ix
        if row is None:
            cur = con.execute('INSERT INTO files(path, source, kind, size, mtime, indexed_at, fmt) VALUES (?,?,?,?,?,?,?)',
                              (path, source, kind, size, mtime, now_ms(), INDEX_FORMAT))
            fid = cur.lastrowid
        else:
            fid = row['id']
            ix.delete_file_docs(fid)
        docs = []
        mtime_ms = int(mtime * 1000)
        if source == 'memory':
            docs = self.memory_docs(path, text, mtime_ms)
        elif source == 'orders':
            docs = self.order_docs(path, text, mtime_ms)
        elif source == 'reviews':
            docs = self.review_docs(path, text, mtime_ms)
        seq = 0
        for d in docs:
            if ix.forgotten(None, d['project'], d['ts']):
                continue
            body = mask_secrets(d['text'])
            pieces = chunk_text(body) if d.get('chunk', True) else [body]
            for i, piece in enumerate(pieces):
                ex = dict(mask_obj(d.get('extra') or {}))
                if len(pieces) > 1:
                    ex['chunk'] = i
                ix.emit({'sid': None, 'project': d['project'], 'ts': d['ts'], 'kind': d['kind'], 'role': d['role'],
                         'source': 'claude', 'ref': d.get('ref') or 'f%s' % fid, 'seq': seq, 'sub': 0,
                         'file_id': fid, 'dkey': None, 'text': piece, 'extra': ex or None})
                seq += 1
        ix.flush()
        project = docs[0]['project'] if docs else None
        con.execute('UPDATE files SET size=?, mtime=?, offset=?, project=?, transcript_exists=1, indexed_at=?, fmt=? '
                    'WHERE id=?', (size, mtime, size, project, now_ms(), INDEX_FORMAT, fid))

    def memory_project(self, path):
        pdir = os.path.dirname(os.path.dirname(path))
        mangled = os.path.basename(pdir)
        counts = {}
        for fpath, project in self.con.execute(
                "SELECT path, project FROM files WHERE source='claude' AND kind='main' AND project IS NOT NULL"):
            if os.path.dirname(fpath) == pdir:
                counts[project] = counts.get(project, 0) + 1
        if counts:
            return max(counts.items(), key=lambda kv: kv[1])[0]
        real = unmangle(mangled)
        if real:
            return self.ix.projects.key(real)
        naive = mangled.replace('--claude-worktrees-', '/.claude/worktrees/')
        naive = '/' + naive.lstrip('-').replace('-', '/') if naive.startswith('-') else naive
        return strip_worktree(naive)

    def memory_docs(self, path, text, mtime_ms):
        fm, body = {}, text
        if text.startswith('---'):
            end = text.find('\n---', 3)
            if end > 0:
                for line in text[3:end].split('\n'):
                    m = re.match(r'^\s*([\w-]+)\s*:\s*(.*)$', line)
                    if m and m.group(2).strip():
                        fm.setdefault(m.group(1), m.group(2).strip().strip('"\''))
                body = text[end + 4:].lstrip('-').strip()
        name = fm.get('name')
        desc = fm.get('description')
        head = ': '.join(x for x in (name, desc) if x)
        full = (head + '\n\n' + body) if head else body
        if not full.strip():
            return []
        extra = {'file': path, 'name': name or os.path.basename(path)[:-3], 'type': fm.get('type'),
                 'originSession': fm.get('originSessionId')}
        return [{'kind': 'memory', 'role': 'assistant', 'project': self.memory_project(path), 'ts': mtime_ms,
                 'text': clip(full, 30_000), 'extra': {k: v for k, v in extra.items() if v}}]

    def order_docs(self, path, text, mtime_ms):
        data = loads(text, None)
        if data is None:
            return []
        root = data.get('root') if isinstance(data, dict) else None
        orders = data.get('orders') if isinstance(data, dict) else data
        if not isinstance(orders, list):
            return []
        project = self.ix.projects.key(root) if isinstance(root, str) and root else None
        out = []
        for o in orders[:500]:
            t = o if isinstance(o, str) else (o.get('text') if isinstance(o, dict) else None)
            if not isinstance(t, str) or not t.strip():
                continue
            at = o.get('addedAt') if isinstance(o, dict) else None
            out.append({'kind': 'order', 'role': 'user', 'project': project,
                        'ts': ts_ms(at) if isinstance(at, (int, float)) and at > 0 else mtime_ms,
                        'text': clip(t.strip(), 2000), 'chunk': False,
                        'extra': {'file': path, 'root': root} if root else {'file': path}})
        return out

    def review_docs(self, path, text, mtime_ms):
        subject = re.search(r'^# Second opinion: (.*)$', text, re.M)
        proj = re.search(r'^- Project: (.*)$', text, re.M)
        model = re.search(r'^- Model: (\S+)', text, re.M)
        written = re.search(r'^- Written: (\S+)', text, re.M)
        rule = text.find('\n---\n')
        body = text[rule + 5:].strip() if rule >= 0 else text
        stamp = re.match(r'^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.md$', os.path.basename(path))
        ts = None
        if stamp:
            ts = ts_ms('%sT%s:%s:%sZ' % stamp.groups())
        ts = ts or (ts_ms(written.group(1)) if written else None) or mtime_ms
        name = proj.group(1).strip() if proj else None
        folder = os.path.basename(os.path.dirname(path))
        paths = set()
        for a, b in self.con.execute('SELECT cwd, project FROM cwd_projects'):
            paths.update((a, b))
        for (k,) in self.con.execute('SELECT DISTINCT project FROM files WHERE project IS NOT NULL'):
            paths.add(k)
        project = None
        for cand in sorted(p for p in paths if p and p.startswith('/')):
            if second_opinion_key(cand) == folder:
                project = self.ix.projects.key(cand)
                break
        if project is None and name:
            low = name.lower()
            keys = sorted({self.ix.projects.key(p) for p in paths if p and p.startswith('/')} - {None})
            matches = [k for k in keys if (project_name(k) or '').lower() == low]
            project = matches[0] if len(matches) == 1 else name
        subj = subject.group(1).strip() if subject else os.path.basename(path)
        return [{'kind': 'review', 'role': 'assistant', 'project': project, 'ts': ts,
                 'text': clip('Second opinion: %s\n\n%s' % (subj, body), 40_000),
                 'extra': {k: v for k, v in {'file': path, 'subject': subj,
                                             'model': model.group(1) if model else None}.items() if v}}]


def acquire_lock(db_path: str, wait: float = 0.0):
    lock_path = db_path + '.lock'
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    deadline = time.time() + wait
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except OSError as e:
            if e.errno not in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES):
                os.close(fd)
                raise
            if time.time() >= deadline:
                os.close(fd)
                return None
            time.sleep(0.1)


# --------------------------------------------------------------------------------------------
# Query parsing

_FILTER_KEYS = ('project', 'kind', 'kinds', 'since', 'until', 'source', 'session', 'routines', 'routine')


class Query:
    def __init__(self):
        self.groups = []      # AND of OR-groups of FTS terms
        self.negatives = []   # FTS terms to exclude
        self.words = []       # raw words, for the fallback query and Python highlighting
        self.filters = {}


def _fts_term(raw: str, phrase=False):
    """An FTS5 expression for a user term, or None when it holds nothing searchable.

    A hyphen/underscore compound also matches without its leading/trailing dashes and as the
    phrase of its pieces: `--delete-branch-on-merge` -> ("--delete-branch-on-merge" OR
    "delete-branch-on-merge" OR "delete branch on merge")."""
    t = raw.strip()
    prefix = False
    if not phrase and t.endswith('*'):
        t = t.rstrip('*')
        prefix = True
    t = t.replace('*', ' ') if not phrase else t
    if not re.search(r'\w', t):
        return None

    def quote(x):
        return '"%s"' % x.replace('"', '""')
    star = '*' if prefix else ''
    if phrase or ('-' not in t and '_' not in t):
        return quote(t) + star
    alts = [quote(t) + star]
    stripped = t.strip('-_')
    if stripped != t and ('-' in stripped or '_' in stripped):
        alts.append(quote(stripped) + star)
    pieces = re.findall(r'[^\W_]+', t)
    if len(pieces) > 1:
        alts.append(quote(' '.join(pieces)) + star)  # a phrase's last token takes the prefix
    alts = list(dict.fromkeys(alts))
    return alts[0] if len(alts) == 1 else '(' + ' OR '.join(alts) + ')'


def parse_query(q: str) -> Query:
    out = Query()
    s = q or ''
    i, n = 0, len(s)
    tokens = []   # (kind, value, negated)
    while i < n:
        while i < n and s[i].isspace():
            i += 1
        if i >= n:
            break
        neg = False
        if s[i] == '-' and i + 1 < n and not s[i + 1].isspace() and s[i + 1] != '-':  # --flag is a term
            neg = True
            i += 1
        if s[i] == '"':
            j = s.find('"', i + 1)
            j = n if j < 0 else j
            tokens.append(('phrase', s[i + 1:j], neg))
            i = j + 1
            continue
        j = i
        while j < n and not s[j].isspace():
            if s[j] == '"' and j > i and s[j - 1] == ':':
                k = s.find('"', j + 1)
                j = n if k < 0 else k + 1
                continue
            j += 1
        word = s[i:j]
        i = j
        m = re.match(r'^(\w+):(.*)$', word)
        if m and m.group(1).lower() in _FILTER_KEYS and m.group(2):
            out.filters[m.group(1).lower()] = m.group(2).strip('"')
            continue
        tokens.append(('word', word, neg))
    pending_or = False
    negate_next = False
    for kind, value, neg in tokens:
        if kind == 'word' and value == 'OR':
            pending_or = bool(out.groups)
            continue
        if kind == 'word' and value == 'AND':
            continue
        if kind == 'word' and value == 'NOT':
            negate_next = True
            continue
        term = _fts_term(value, phrase=(kind == 'phrase'))
        if term is None:
            pending_or = False
            continue
        out.words.extend(re.findall(r'\w[\w\-]*', value))
        if neg or negate_next:
            out.negatives.append(term)
            negate_next = False
            pending_or = False
            continue
        if pending_or and out.groups:
            out.groups[-1].append(term)
        else:
            out.groups.append([term])
        pending_or = False
    return out


def match_expr(q: Query) -> str | None:
    if not q.groups:
        return None
    parts = [g[0] if len(g) == 1 else '(' + ' OR '.join(g) + ')' for g in q.groups]
    expr = ' AND '.join(parts)
    if q.negatives:
        expr = '(%s) NOT (%s)' % (expr, ' OR '.join(q.negatives))
    return expr


def fallback_expr(q: Query, raw: str) -> str | None:
    words = re.findall(r'\w[\w\-]*', raw or '')
    words = [w for w in words if not re.match(r'^(?:%s)$' % '|'.join(_FILTER_KEYS), w, re.I)]
    if not words:
        return None
    return ' AND '.join('"%s"' % w.replace('"', '""') for w in words[:30])


# --------------------------------------------------------------------------------------------
# Snippets

def cap_snippet(s: str, limit: int = 240) -> str:
    s = re.sub(r'\s+', ' ', s or '').strip()
    if len(s) <= limit:
        return s
    i = s.find('[[')
    start = 0 if i < 0 or i < limit // 3 else max(0, i - limit // 3)
    piece = s[start:start + limit - 2]
    last_open, last_close = piece.rfind('[['), piece.rfind(']]')
    if last_open > last_close:
        piece = piece[:last_open]
    return ('…' if start > 0 else '') + piece.rstrip() + '…'


def py_snippet(text: str, words: list, limit: int = 240) -> str:
    t = re.sub(r'\s+', ' ', text or '').strip()
    words = [w for w in words if w]
    if not words:
        return clip(t, limit)
    rx = re.compile('|'.join(re.escape(w) for w in sorted(set(words), key=len, reverse=True)), re.I)
    m = rx.search(t)
    if not m:
        return clip(t, limit)
    start = max(0, m.start() - limit // 3)
    window = t[start:start + limit - 12]
    window = rx.sub(lambda mm: '[[' + mm.group(0) + ']]', window)
    out = ('…' if start > 0 else '') + window + ('…' if start + limit - 12 < len(t) else '')
    return cap_snippet(out, limit)


# --------------------------------------------------------------------------------------------
# Commands

def _hit_extra(extra_json, sub, agent_name):
    e = loads(extra_json, {}) or {}
    if sub:
        e['subagent'] = True
        if sub == 2:
            e['report'] = True
        if agent_name:
            e['agent'] = agent_name
    return e


def _short_title(title):
    """A session's title, or the start of its first prompt when it has none."""
    return one_line(title, 120) if title else None


def _doc_title(session_title, kind, extra):
    if session_title:
        return session_title
    if kind == 'memory':
        return extra.get('name')
    if kind == 'review':
        return 'Second opinion: %s' % extra.get('subject') if extra.get('subject') else 'Second opinion'
    if kind == 'order':
        return 'Standing order'
    if kind == 'note':
        return 'Note'
    return None


class Filters:
    def __init__(self):
        self.where = []
        self.params = []

    def add(self, clause, *params):
        self.where.append(clause)
        self.params.extend(params)

    def sql(self):
        return (' AND ' + ' AND '.join(self.where)) if self.where else ''


def build_filters(con, opts: dict) -> Filters:
    f = Filters()
    proj = resolve_projects(con, opts.get('project'))
    if proj is not None:
        if proj:
            f.add('(d.project IN (%s) OR d.project IS NULL)' % ','.join('?' * len(proj)), *proj)
        else:
            f.add('0')
    kinds = opts.get('kinds')
    if kinds:
        f.add('d.kind IN (%s)' % ','.join('?' * len(kinds)), *kinds)
    if opts.get('since') is not None:
        f.add('d.ts >= ?', opts['since'])
    if opts.get('until') is not None:
        f.add('d.ts < ?', opts['until'])
    src = (opts.get('source') or 'all').lower()
    if src == 'codex':
        f.add("d.source = 'codex'")
    elif src == 'claude':
        f.add("d.source = 'claude'")
    elif src in ('note', 'notes', 'recall'):
        f.add("d.source = 'recall'")
    if opts.get('session'):
        f.add('d.session_id = ?', opts['session'])
    if opts.get('exclude_session'):
        f.add('(d.session_id IS NULL OR d.session_id != ?)', opts['exclude_session'])
    routines = (opts.get('routines') or 'include').lower()
    if routines == 'exclude':
        f.add('COALESCE(s.routine, 0) = 0')
    elif routines == 'only':
        f.add('s.routine = 1')
    return f


def _kinds_arg(value):
    if not value:
        return None
    kinds = [k.strip().lower() for k in value.split(',') if k.strip()]
    return kinds or None


def cmd_search(con, args):
    raw = args.query or ''
    q = parse_query(raw)
    fl = q.filters
    opts = {
        'project': fl.get('project', args.project),
        'kinds': _kinds_arg(fl.get('kind') or fl.get('kinds')) or _kinds_arg(args.kinds),
        'since': parse_time(fl['since']) if fl.get('since') else (parse_time(args.since) if args.since else None),
        'until': parse_time(fl['until'], end=True) if fl.get('until') else (parse_time(args.until, end=True) if args.until else None),
        'source': fl.get('source', args.source),
        'session': fl.get('session'),
        'exclude_session': args.exclude_session,
        'routines': fl.get('routines') or fl.get('routine') or args.routines,
    }
    if opts['routines'] and opts['routines'].lower() not in ('include', 'exclude', 'only'):
        raise RecallError('routines must be include, exclude or only')
    limit = max(1, min(int(args.limit or 8), 100))
    recency = _recency_sql(con, args.half_life_days, now_ms())
    filt = build_filters(con, opts)
    boost = None
    if args.boost_project:
        b = resolve_projects(con, args.boost_project)
        boost = b if b else None
    kind_case = 'CASE d.kind ' + ' '.join("WHEN '%s' THEN %s" % (k, w) for k, w in KIND_WEIGHTS.items()) + ' ELSE 1.0 END'
    routine_w = '1.0' if (opts['routines'] or '').lower() == 'only' else \
        'CASE WHEN COALESCE(s.routine, 0) = 1 THEN %s ELSE 1.0 END' % ROUTINE_WEIGHT
    sub_w = ("CASE d.sub WHEN 1 THEN %s ELSE 1.0 END * CASE WHEN d.role = 'notification' THEN %s ELSE 1.0 END"
             " * CASE WHEN d.flags & %d THEN %s ELSE 1.0 END" % (SUB_WEIGHT, NOTIFICATION_WEIGHT, FLAG_INSPECT,
                                                               INSPECT_WEIGHT))
    boost_sql, boost_params = '1.0', []
    if boost:
        boost_sql = 'CASE WHEN d.project IN (%s) THEN %s ELSE 1.0 END' % (','.join('?' * len(boost)), BOOST_WEIGHT)
        boost_params = list(boost)
    expr = match_expr(q)
    pool_size = max(200, limit * 25)
    rows, total, used_expr = [], 0, None
    fallback = fallback_expr(q, raw)
    if expr is None and not q.negatives and not _has_filters(opts):
        expr = fallback
        if expr is None:
            return {'query': raw, 'total': 0, 'hits': [], 'sessions': []}
    candidates = ([expr] + ([fallback] if fallback and fallback != expr else [])) if expr else [None]
    for cand in candidates:
        try:
            if cand is None:
                rows, total = _list_mode(con, q, filt, kind_case, recency, routine_w, sub_w, boost_sql, boost_params,
                                         pool_size)
            else:
                # FTS5 clamps the IDF of terms found in over half the docs to ~0; the epsilon keeps such
                # hits ordered by kind, recency and boosts instead of all scoring zero
                score = '(0.001 - bm25(docs_fts, 1.0, 0.4)) * %s * %s * %s * %s * %s' % (
                    kind_case, recency, boost_sql, routine_w, sub_w)
                # one pass: every match's score, so `total` needs no second query; the best are kept here
                sql = ('SELECT d.id, %s FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid '
                       'LEFT JOIN sessions s ON s.session_id = d.session_id WHERE docs_fts MATCH ?%s') % (
                    score, filt.sql())
                allrows = con.execute(sql, boost_params + [cand] + filt.params).fetchall()
                total = len(allrows)
                rows = heapq.nlargest(pool_size, allrows, key=lambda r: r[1])
            used_expr = cand
            break
        except sqlite3.OperationalError:
            rows, total = [], 0
            continue
    ids = [r[0] for r in rows]
    scores = {r[0]: r[1] for r in rows}
    details = _doc_details(con, ids)
    hits, seen_keys, sessions = [], set(), {}
    for did in ids:
        d = details.get(did)
        if not d:
            continue
        sid = d['session_id']
        if sid:
            agg = sessions.setdefault(sid, {'hits': 0, 'best': scores[did]})
            agg['hits'] += 1
        if len(hits) >= limit:
            continue
        key = (sid or 'f%s' % d['file_id'], re.sub(r'\W+', ' ', d['text'][:200].lower()).strip())
        if key in seen_keys:
            continue
        seen_keys.add(key)
        hits.append(did)
    snippets = {}
    if hits and used_expr:
        try:
            for rid, snip in con.execute(
                    "SELECT rowid, snippet(docs_fts, 0, '[[', ']]', '…', 40) FROM docs_fts WHERE docs_fts MATCH ? "
                    "AND rowid IN (%s)" % ','.join('?' * len(hits)), [used_expr] + hits):
                snippets[rid] = snip
        except sqlite3.OperationalError:
            pass
    words = q.words or re.findall(r'\w[\w\-]*', raw)
    out_hits = []
    for did in hits:
        d = details[did]
        snip = snippets.get(did)
        snip = cap_snippet(snip) if snip and '[[' in snip else py_snippet(d['text'], words)
        extra = _hit_extra(d['extra'], d['sub'], d['agent_name'])
        out_hits.append({'ref': 'd%d' % did, 'session': d['session_id'], 'project': d['project'],
                         'projectName': project_name(d['project']),
                         'title': _doc_title(d['title'], d['kind'], extra), 'ts': d['ts'], 'kind': d['kind'],
                         'role': d['role'], 'source': d['source'], 'snippet': snip,
                         'score': float('%.6g' % scores[did]), 'extra': extra})
    sess_out = []
    if sessions:
        sids = sorted(sessions, key=lambda s: -sessions[s]['best'])[:10]
        info = {r[0]: r for r in con.execute(
            'SELECT session_id, COALESCE(title, substr(first_prompt, 1, 200)), project, last_ts, transcript_exists, routine '
            'FROM sessions WHERE session_id IN (%s)'
            % ','.join('?' * len(sids)), sids)}
        for sid in sids:
            r = info.get(sid)
            sess_out.append({'session': sid, 'title': _short_title(r[1]) if r else None,
                             'projectName': project_name(r[2]) if r else None, 'hits': sessions[sid]['hits'],
                             'lastTs': r[3] if r else None, 'transcriptExists': bool(r[4]) if r else False})
    return {'query': raw, 'total': total, 'hits': out_hits, 'sessions': sess_out}


def _has_filters(opts):
    return any(opts.get(k) for k in ('kinds', 'since', 'until', 'session')) or \
        (opts.get('project') and opts['project'].lower() != 'all') or \
        (opts.get('source') and opts['source'].lower() != 'all') or \
        (opts.get('routines') or 'include').lower() == 'only'


def _list_mode(con, q, filt, kind_case, recency, routine_w, sub_w, boost_sql, boost_params, pool):
    """Filter-only queries (no positive terms): newest first, weighted like search."""
    neg = ''
    params = []
    if q.negatives:
        neg = ' AND d.id NOT IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?)'
        params = [' OR '.join(q.negatives)]
    score = '%s * %s * %s * %s * %s' % (kind_case, recency, boost_sql, routine_w, sub_w)
    sql = ('SELECT d.id, %s AS score FROM docs d LEFT JOIN sessions s ON s.session_id = d.session_id '
           'WHERE 1%s%s ORDER BY d.ts DESC LIMIT ?') % (score, filt.sql(), neg)
    rows = con.execute(sql, boost_params + filt.params + params + [pool]).fetchall()
    total = con.execute('SELECT COUNT(*) FROM docs d LEFT JOIN sessions s ON s.session_id = d.session_id WHERE 1%s%s'
                        % (filt.sql(), neg), filt.params + params).fetchone()[0]
    rows.sort(key=lambda r: -r[1])
    return rows, total


def _doc_details(con, ids):
    if not ids:
        return {}
    out = {}
    for i in range(0, len(ids), 500):
        part = ids[i:i + 500]
        for r in con.execute(
                'SELECT d.id, d.session_id, d.project, d.ts, d.kind, d.role, d.source, d.sub, d.extra, t.text, d.file_id, '
                'COALESCE(s.title, substr(s.first_prompt, 1, 200)), f.agent_name, d.ref_uuid, d.seq, d.flags FROM docs d '
                'JOIN docs_text t ON t.id = d.id LEFT JOIN sessions s ON s.session_id = d.session_id '
                'LEFT JOIN files f ON f.id = d.file_id WHERE d.id IN (%s)' % ','.join('?' * len(part)), part):
            out[r[0]] = {'id': r[0], 'session_id': r[1], 'project': r[2], 'ts': r[3], 'kind': r[4], 'role': r[5],
                         'source': r[6], 'sub': r[7], 'extra': r[8], 'text': r[9], 'file_id': r[10],
                         'title': _short_title(r[11]),
                         'agent_name': r[12], 'ref_uuid': r[13], 'seq': r[14], 'flags': r[15]}
    return out


def _ref_id(ref: str) -> int:
    m = re.fullmatch(r'd?(\d+)', (ref or '').strip())
    if not m:
        raise RecallError('bad ref %r (expected d123)' % ref)
    return int(m.group(1))


def _resume(source, sid):
    if not sid:
        return None
    return ('codex resume %s' % sid) if source == 'codex' else ('claude --resume %s' % sid)


def cmd_expand(con, args):
    did = _ref_id(args.ref)
    d = _doc_details(con, [did]).get(did)
    if not d:
        raise RecallError('no doc %s' % args.ref)
    before = max(0, min(int(args.before), 50))
    after = max(0, min(int(args.after), 50))
    max_chars = max(200, min(int(args.max_chars), 50_000))
    kinds = EXPAND_KINDS
    kq = ','.join('?' * len(kinds))
    if d['session_id']:
        if d['sub']:
            scope, sp = 'file_id = ?', [d['file_id']]
        else:
            scope, sp = 'session_id = ? AND sub = 0', [d['session_id']]
    elif d['file_id']:
        scope, sp = 'file_id = ?', [d['file_id']]
    else:
        scope, sp = 'id = ?', [did]
    prev = con.execute('SELECT id FROM docs WHERE %s AND kind IN (%s) AND (ts < ? OR (ts = ? AND seq < ?)) '
                       'ORDER BY ts DESC, seq DESC LIMIT ?' % (scope, kq),
                       sp + list(kinds) + [d['ts'], d['ts'], d['seq'], before]).fetchall()
    nxt = con.execute('SELECT id FROM docs WHERE %s AND kind IN (%s) AND (ts > ? OR (ts = ? AND seq > ?)) '
                      'ORDER BY ts, seq LIMIT ?' % (scope, kq),
                      sp + list(kinds) + [d['ts'], d['ts'], d['seq'], after]).fetchall()
    before_ids = [r[0] for r in reversed(prev)]
    after_ids = [r[0] for r in nxt]
    focus_cap = min(len(d['text']), max(max_chars // 2, max_chars - (len(before_ids) + len(after_ids)) * 120))
    rest = max(0, max_chars - focus_cap)
    while before_ids or after_ids:
        if rest // (len(before_ids) + len(after_ids)) >= 80:
            break
        if len(before_ids) >= len(after_ids):
            before_ids.pop(0)  # the farthest neighbours go first
        else:
            after_ids.pop()
    order = before_ids + [did] + after_ids
    det = _doc_details(con, order)
    others = len(order) - 1
    per = rest // others if others else 0
    items = []
    for i in order:
        x = det[i]
        cap = focus_cap if i == did else per
        item = {'ref': 'd%d' % i, 'ts': x['ts'], 'kind': x['kind'], 'role': x['role'], 'text': clip(x['text'], cap)}
        if x['sub']:
            item['subagent'] = True
        if x.get('flags', 0) & FLAG_INSPECT:
            item['inspect'] = True
        items.append(item)
    sess = None
    if d['session_id']:
        r = con.execute('SELECT session_id, COALESCE(title, substr(first_prompt, 1, 200)), project, first_ts, last_ts, '
                        'source, transcript_exists, transcript_path FROM sessions WHERE session_id=?',
                        (d['session_id'],)).fetchone()
        if r:
            sess = {'session': r[0], 'title': _short_title(r[1]), 'project': r[2], 'projectName': project_name(r[2]),
                    'start': r[3],
                    'end': r[4], 'source': r[5], 'resume': _resume(r[5], r[0]), 'transcriptExists': bool(r[6]),
                    'transcriptPath': r[7]}
        else:
            sess = {'session': d['session_id'], 'title': None, 'project': d['project'],
                    'projectName': project_name(d['project']), 'start': None, 'end': None, 'source': d['source'],
                    'resume': _resume(d['source'], d['session_id']), 'transcriptExists': False, 'transcriptPath': None}
        if d['sub']:
            sess['agent'] = d['agent_name']
    return {'session': sess, 'focus': 'd%d' % did, 'items': items}


def _routine_clause(value, alias='s'):
    v = (value or 'include').lower()
    if v not in ('include', 'exclude', 'only'):
        raise RecallError('routines must be include, exclude or only')
    if v == 'exclude':
        return ' AND %s.routine = 0' % alias
    if v == 'only':
        return ' AND %s.routine = 1' % alias
    return ''


def cmd_recap(con, args):
    count = max(1, min(int(args.count or 1), 10))
    if args.session:
        rows = con.execute('SELECT session_id FROM sessions WHERE session_id=?', (args.session,)).fetchall()
        if not rows:
            raise RecallError('no session %s' % args.session)
    else:
        where, params = 'WHERE 1', []
        proj = resolve_projects(con, args.project)
        if proj is not None:
            if not proj:
                return {'sessions': []}
            where += ' AND s.project IN (%s)' % ','.join('?' * len(proj))
            params += proj
        if args.exclude_session:
            where += ' AND s.session_id != ?'
            params.append(args.exclude_session)
        where += _routine_clause(args.routines)
        rows = con.execute('SELECT s.session_id FROM sessions s %s ORDER BY s.last_ts DESC LIMIT ?' % where,
                           params + [count]).fetchall()
    return {'sessions': [_recap_one(con, r[0]) for r in rows]}


def _recap_one(con, sid):
    s = con.execute('SELECT session_id, title, project, first_ts, last_ts, prompt_count, routine, first_prompt, source, '
                    'transcript_exists FROM sessions WHERE session_id=?', (sid,)).fetchone()
    if s is None:
        s = (sid, None, None, None, None, 0, 0, None, 'claude', 0)
    last_prompts = [r[0] for r in con.execute(
        "SELECT t.text FROM docs d JOIN docs_text t ON t.id = d.id WHERE d.session_id=? AND d.kind='prompt' AND d.sub=0 "
        "AND (d.extra IS NULL OR json_extract(d.extra, '$.chunk') IS NULL OR json_extract(d.extra, '$.chunk') = 0) "
        "ORDER BY d.ts DESC, d.seq DESC LIMIT 3", (sid,))]
    last_prompts = [clip(t, 400) for t in reversed(last_prompts)]
    last = con.execute("SELECT ref_uuid FROM docs WHERE session_id=? AND kind='answer' AND sub=0 AND role='assistant' "
                       "ORDER BY ts DESC, seq DESC LIMIT 1", (sid,)).fetchone()
    last_answer = None
    if last:
        parts = [r[0] for r in con.execute("SELECT t.text FROM docs d JOIN docs_text t ON t.id = d.id WHERE "
                                           "d.session_id=? AND d.kind='answer' AND d.ref_uuid IS ? AND d.sub=0 "
                                           "ORDER BY d.seq", (sid, last[0]))]
        last_answer = clip('\n\n'.join(parts), 1500)
    commits, prs, issues, files, tasks, decisions = [], [], [], {}, [], []
    for kind, text, extra in con.execute(
            "SELECT d.kind, t.text, d.extra FROM docs d JOIN docs_text t ON t.id = d.id WHERE d.session_id=? AND "
            "d.kind IN ('commit','pr','issue','file','task') ORDER BY d.ts, d.seq", (sid,)):
        e = loads(extra, {}) or {}
        if kind == 'commit' and len(commits) < 20:
            commits.append({'sha': e.get('sha'), 'message': one_line((e.get('message') or text).split('\n', 1)[0], 200)})
        elif kind == 'pr' and len(prs) < 20:
            prs.append({'number': e.get('number'), 'url': e.get('url'), 'title': e.get('title')})
        elif kind == 'issue' and len(issues) < 20:
            issues.append({'number': e.get('number'), 'url': e.get('url'), 'title': e.get('title')})
        elif kind == 'file':
            p = e.get('path') or text
            files[p] = files.get(p, 0) + int(e.get('edits') or 1)
        elif kind == 'task' and (e.get('status') or 'pending') in ('pending', 'in_progress') and len(tasks) < 20:
            tasks.append(one_line(e.get('subject') or text.split('\n', 1)[0], 300))
    for (text,) in con.execute("SELECT t.text FROM docs d JOIN docs_text t ON t.id = d.id WHERE d.session_id=? AND "
                               "d.kind='decision' ORDER BY d.ts DESC, d.seq DESC LIMIT 5", (sid,)):
        decisions.append(clip(text, 500))
    top_files = [p for p, _ in sorted(files.items(), key=lambda kv: (-kv[1], kv[0]))[:12]]
    return {'session': s[0], 'title': _short_title(s[1] or s[7]), 'projectName': project_name(s[2]), 'start': s[3],
            'end': s[4],
            'prompts': s[5], 'routine': bool(s[6]), 'firstPrompt': clip(s[7], 500) if s[7] else None,
            'lastPrompts': last_prompts, 'lastAnswer': last_answer, 'commits': commits, 'prs': prs, 'issues': issues,
            'files': top_files, 'openTasks': tasks, 'decisions': decisions, 'resume': _resume(s[8], s[0]),
            'transcriptExists': bool(s[9])}


def cmd_timeline(con, args):
    since = parse_time(args.since) if args.since else parse_time('14d')
    limit = max(1, min(int(args.limit or 60), 500))
    where, params = 'WHERE COALESCE(s.last_ts, s.first_ts, 0) >= ?', [since]
    proj = resolve_projects(con, args.project)
    if proj is not None:
        if not proj:
            return {'days': []}
        where += ' AND s.project IN (%s)' % ','.join('?' * len(proj))
        params += proj
    where += _routine_clause(args.routines)
    rows = con.execute(
        'SELECT s.session_id, COALESCE(s.title, substr(s.first_prompt, 1, 200)), s.project, s.first_ts, s.last_ts, s.prompt_count, s.routine, s.source, '
        "(SELECT COUNT(*) FROM docs d WHERE d.session_id = s.session_id AND d.kind='commit'), "
        "(SELECT COUNT(*) FROM docs d WHERE d.session_id = s.session_id AND d.kind='pr') "
        'FROM sessions s %s ORDER BY COALESCE(s.first_ts, s.last_ts) DESC LIMIT ?' % where, params + [limit]).fetchall()
    days = {}
    for r in rows:
        start = r[3] or r[4] or 0
        days.setdefault(local_date(start), []).append(
            {'session': r[0], 'title': _short_title(r[1]), 'projectName': project_name(r[2]), 'start': r[3], 'end': r[4],
             'prompts': r[5], 'commits': r[8], 'prs': r[9], 'routine': bool(r[6]), 'source': r[7]})
    return {'days': [{'date': k, 'sessions': v} for k, v in sorted(days.items(), reverse=True)]}


def _items(con, rows):
    out = []
    for r in rows:
        did, ts, sid, project, kind, text, extra, title, sub, agent_name = r
        e = _hit_extra(extra, sub, agent_name)
        out.append({'ref': 'd%d' % did, 'ts': ts, 'session': sid, 'projectName': project_name(project),
                    'title': _doc_title(_short_title(title), kind, e), 'kind': kind, 'text': clip(text, 1000),
                    'extra': e})
    return out


def cmd_list(con, args):
    kind = (args.kind or '').lower()
    if kind not in ALL_KINDS:
        raise RecallError('unknown kind %r (one of %s)' % (args.kind, ', '.join(ALL_KINDS)))
    limit = max(1, min(int(args.limit or 20), 200))
    opts = {'project': args.project, 'kinds': [kind], 'since': parse_time(args.since) if args.since else None,
            'until': parse_time(args.until, end=True) if getattr(args, 'until', None) else None}
    filt = build_filters(con, opts)
    if kind == 'command' and not args.include_inspect:
        filt.add('(d.flags & %d) = 0' % FLAG_INSPECT)
    base = ('SELECT d.id, d.ts, d.session_id, d.project, d.kind, t.text, d.extra, '
            'COALESCE(s.title, substr(s.first_prompt, 1, 200)), d.sub, f.agent_name FROM docs d '
            'JOIN docs_text t ON t.id = d.id LEFT JOIN sessions s ON s.session_id = d.session_id '
            'LEFT JOIN files f ON f.id = d.file_id ')
    rows = []
    if args.query:
        q = parse_query(args.query)
        for expr in (match_expr(q), fallback_expr(q, args.query)):
            if not expr:
                continue
            try:
                rows = con.execute(base + 'WHERE d.id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?)%s '
                                   'ORDER BY d.ts DESC, d.seq DESC LIMIT ?' % filt.sql(),
                                   [expr] + filt.params + [limit]).fetchall()
                break
            except sqlite3.OperationalError:
                continue
    else:
        rows = con.execute(base + 'WHERE 1%s ORDER BY d.ts DESC, d.seq DESC LIMIT ?' % filt.sql(),
                           filt.params + [limit]).fetchall()
    return {'items': _items(con, rows)}


def _note_project(con, value):
    if not value:
        return None
    keys = resolve_projects(con, value)
    if keys:
        return keys[0]
    if value.startswith(('/', '~')):
        return strip_worktree(os.path.normpath(os.path.expanduser(value)))
    return value


def cmd_note(con, args):
    action = args.note_action
    if action == 'add':
        text = (args.text or '').strip()
        if not text:
            raise RecallError('note add needs --text')
        project = _note_project(con, args.project)
        ts = now_ms()
        body = mask_secrets(clip(text, 10_000))
        with Tx(con):
            cur = con.execute("INSERT INTO docs(session_id, project, ts, kind, role, source, seq, sub) "
                              "VALUES (NULL, ?, ?, 'note', 'user', 'recall', 0, 0)", (project, ts))
            con.execute('INSERT INTO docs_text(id, text, parts) VALUES (?, ?, ?)', (cur.lastrowid, body, parts_of(body)))
        return {'note': {'ref': 'd%d' % cur.lastrowid, 'ts': ts, 'projectName': project_name(project), 'text': body}}
    if action == 'list':
        opts = {'project': args.project, 'kinds': ['note']}
        filt = build_filters(con, opts)
        rows = con.execute('SELECT d.id, d.ts, d.session_id, d.project, d.kind, t.text, d.extra, s.title, d.sub, NULL '
                           'FROM docs d JOIN docs_text t ON t.id = d.id LEFT JOIN sessions s ON s.session_id = d.session_id '
                           'WHERE 1%s '
                           'ORDER BY d.ts DESC LIMIT ?' % filt.sql(), filt.params + [max(1, min(int(args.limit or 50), 200))]).fetchall()
        return {'items': _items(con, rows)}
    if action == 'forget':
        did = _ref_id(args.ref)
        con.execute('PRAGMA secure_delete=ON')
        with Tx(con):
            row = con.execute('SELECT kind FROM docs WHERE id=?', (did,)).fetchone()
            if row and row[0] != 'note':
                raise RecallError('%s is not a note (use forget for sessions)' % args.ref)
            cur = con.execute("DELETE FROM docs WHERE id=? AND kind='note'", (did,))
        return {'forgotten': max(0, cur.rowcount)}
    raise RecallError('note needs add, list or forget')


def cmd_forget(con, args, db_path):
    if not (args.session or args.project or args.before):
        raise RecallError('forget needs --session, --project or --before')
    lock = acquire_lock(db_path, wait=30)
    try:
        con.execute('PRAGMA secure_delete=ON')
        now = now_ms()
        docs = sessions = 0
        with Tx(con):
            if args.session:
                docs += max(0, con.execute('DELETE FROM docs WHERE session_id=?', (args.session,)).rowcount)
                sessions += max(0, con.execute('DELETE FROM sessions WHERE session_id=?', (args.session,)).rowcount)
                con.execute("INSERT OR REPLACE INTO forgotten(kind, value, at) VALUES ('session', ?, ?)", (args.session, now))
            if args.project:
                keys = resolve_projects(con, args.project)
                if keys is None:
                    raise RecallError('forget --project needs a project, not all')
                for key in keys:
                    sids = [r[0] for r in con.execute('SELECT session_id FROM sessions WHERE project=?', (key,))]
                    for sid in sids:
                        docs += max(0, con.execute('DELETE FROM docs WHERE session_id=?', (sid,)).rowcount)
                    docs += max(0, con.execute('DELETE FROM docs WHERE project=?', (key,)).rowcount)
                    sessions += max(0, con.execute('DELETE FROM sessions WHERE project=?', (key,)).rowcount)
                    con.execute("INSERT OR REPLACE INTO forgotten(kind, value, at) VALUES ('project', ?, ?)", (key, now))
            if args.before:
                cutoff = parse_time(args.before)
                sids = [r[0] for r in con.execute('SELECT session_id FROM sessions WHERE COALESCE(last_ts, 0) < ?', (cutoff,))]
                for sid in sids:
                    docs += max(0, con.execute('DELETE FROM docs WHERE session_id=?', (sid,)).rowcount)
                docs += max(0, con.execute('DELETE FROM docs WHERE ts < ?', (cutoff,)).rowcount)
                sessions += max(0, con.execute('DELETE FROM sessions WHERE COALESCE(last_ts, 0) < ?', (cutoff,)).rowcount)
                old = con.execute("SELECT value FROM forgotten WHERE kind='before'").fetchone()
                if not old or int(old[0]) < cutoff:
                    con.execute("DELETE FROM forgotten WHERE kind='before'")
                    con.execute("INSERT INTO forgotten(kind, value, at) VALUES ('before', ?, ?)", (str(cutoff), now))
        return {'forgotten': {'docs': docs, 'sessions': sessions}}
    finally:
        if lock is not None:
            os.close(lock)


def cmd_projects(con, args):
    out = {}
    for key, n, last in con.execute('SELECT project, COUNT(*), MAX(last_ts) FROM sessions WHERE project IS NOT NULL '
                                    'GROUP BY project'):
        out[key] = {'key': key, 'name': project_name(key), 'paths': [], 'sessions': n, 'lastTs': last}
    for key, last in con.execute('SELECT project, MAX(ts) FROM docs WHERE session_id IS NULL AND project IS NOT NULL '
                                 'GROUP BY project'):
        if key not in out:
            out[key] = {'key': key, 'name': project_name(key), 'paths': [], 'sessions': 0, 'lastTs': last}
    for key, path in con.execute('SELECT project, path FROM project_paths ORDER BY path'):
        if key in out and len(out[key]['paths']) < 20:
            out[key]['paths'].append(path)
    for p in out.values():
        if not p['paths'] and p['key'].startswith('/'):
            p['paths'] = [p['key']]
    return {'projects': sorted(out.values(), key=lambda p: -(p['lastTs'] or 0))}


def stats(con, db_path):
    size = 0
    for suffix in ('', '-wal'):
        try:
            size += os.path.getsize(db_path + suffix)
        except OSError:
            pass
    by_kind = dict(con.execute('SELECT kind, COUNT(*) FROM docs GROUP BY kind ORDER BY kind').fetchall())
    by_source = dict(con.execute('SELECT source, COUNT(*) FROM docs GROUP BY source ORDER BY source').fetchall())
    lo, hi = con.execute('SELECT MIN(ts), MAX(ts) FROM docs WHERE ts > 0').fetchone()
    last = meta_get(con, 'last_update')
    return {
        'db': db_path, 'bytes': size,
        'sessions': con.execute('SELECT COUNT(*) FROM sessions').fetchone()[0],
        'docs': sum(by_kind.values()), 'byKind': by_kind, 'bySource': by_source, 'oldest': lo, 'newest': hi,
        'lastUpdate': int(last) if last else None,
        'transcriptsDeleted': con.execute('SELECT COUNT(*) FROM sessions WHERE transcript_exists=0').fetchone()[0],
        'routineSessions': con.execute('SELECT COUNT(*) FROM sessions WHERE routine=1').fetchone()[0],
        'subagentDocs': con.execute('SELECT COUNT(*) FROM docs WHERE sub>0').fetchone()[0],
        'inspectCommands': con.execute('SELECT COUNT(*) FROM docs WHERE flags & ? != 0', (FLAG_INSPECT,)).fetchone()[0],
        'redactLiterals': len(_REDACT['literals']),
        'projects': con.execute('SELECT COUNT(DISTINCT project) FROM sessions').fetchone()[0],
    }


def remask_all(con) -> dict:
    """Re-applies masking to every stored text that contains a redaction literal, keeps FTS in sync,
    then rewrites the FTS index and the WAL so the old values do not linger in the file."""
    t0 = time.time()
    lits = list(_REDACT['literals'])
    changed = set()
    if lits:
        forms = sorted(set(lits) | {dumps(x)[1:-1] for x in lits}, key=len, reverse=True)  # JSON-escaped too
        con.execute('PRAGMA secure_delete=ON')  # freed pages are zeroed
        with Tx(con):
            for i in range(0, len(lits), 25):
                batch = lits[i:i + 25]
                cond = ' OR '.join(['instr(text, ?) > 0'] * len(batch))
                for did, text in con.execute('SELECT id, text FROM docs_text WHERE ' + cond, batch).fetchall():
                    new = mask_secrets(text)
                    if new != text:
                        con.execute('UPDATE docs_text SET text=?, parts=? WHERE id=?', (new, parts_of(new), did))
                        changed.add(did)
            for i in range(0, len(forms), 25):
                batch = forms[i:i + 25]
                cond = ' OR '.join(['instr(extra, ?) > 0'] * len(batch))
                for did, extra in con.execute('SELECT id, extra FROM docs WHERE extra IS NOT NULL AND (%s)' % cond,
                                              batch).fetchall():
                    obj = loads(extra, None)
                    new = dumps(mask_obj(obj)) if obj is not None else extra
                    if new != extra:
                        con.execute('UPDATE docs SET extra=? WHERE id=?', (new, did))
                        changed.add(did)
            for sid, title, first in con.execute('SELECT session_id, title, first_prompt FROM sessions').fetchall():
                t2 = mask_secrets(title) if title else title
                f2 = mask_secrets(first) if first else first
                if (t2, f2) != (title, first):
                    con.execute('UPDATE sessions SET title=?, first_prompt=? WHERE session_id=?', (t2, f2, sid))
            for fid, state, agent in con.execute('SELECT id, state, agent_name FROM files').fetchall():
                if any(f in (state or '') for f in forms) or any(f in (agent or '') for f in lits):
                    obj = loads(state, None)
                    s2 = dumps(mask_obj(obj)) if obj is not None else state
                    a2 = mask_secrets(agent) if agent else agent
                    con.execute('UPDATE files SET state=?, agent_name=? WHERE id=?', (s2, a2, fid))
        if changed:
            con.execute("INSERT INTO docs_fts(docs_fts) VALUES ('optimize')")  # drops the deleted entries' tokens
        try:
            con.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        except sqlite3.OperationalError:
            pass
    return {'docs': len(changed), 'seconds': round(time.time() - t0, 2)}


def redaction_check(con, home: str, force: bool = False):
    """Re-masks stored text when the literal set changed since the last run (or always with force).
    Returns {'docs', 'seconds'} when a re-mask ran, else None. Only a salted PBKDF2 hash of the set
    and the source files' sizes/mtimes are kept (in meta)."""
    lits = _REDACT['literals']
    sig = _redact_signature(home)
    old_hash = meta_get(con, 'redact_hash')
    if not force and old_hash and meta_get(con, 'redact_sources') == sig:
        return None
    same = bool(old_hash) and _literals_match(old_hash, lits)
    result = None
    if force or (not same and (lits or old_hash) and con.execute('SELECT 1 FROM docs LIMIT 1').fetchone()):
        result = remask_all(con)
    with Tx(con):
        meta_set(con, 'redact_hash', old_hash if same else _new_literal_hash(lits))
        meta_set(con, 'redact_sources', sig)
    return result


def cmd_remask(con, args, db_path, home):
    lock = acquire_lock(db_path, wait=60)
    if lock is None:
        return {'remasked': None, 'busy': True}
    try:
        return {'remasked': redaction_check(con, home, force=True)}
    finally:
        os.close(lock)


def cmd_update(con, args, db_path, home):
    sources = set(SOURCES)
    if args.sources:
        sources = {s.strip().lower() for s in args.sources.split(',') if s.strip()}
        bad = sources - set(SOURCES)
        if bad:
            raise RecallError('unknown source %s (use %s)' % (', '.join(sorted(bad)), ','.join(SOURCES)))
    lock = acquire_lock(db_path)
    if lock is None:
        return {'updated': None, 'busy': True}
    try:
        remasked = redaction_check(con, home)
        if args.prune_deleted or args.retention_days:
            con.execute('PRAGMA secure_delete=ON')
        up = Updater(con, db_path, home, args)
        result = up.run(sources)
        if remasked is not None:
            result['remasked'] = remasked['docs']
        if result['docs_added'] > 20000:
            try:
                con.execute("INSERT INTO docs_fts(docs_fts) VALUES ('optimize')")
            except sqlite3.OperationalError:
                pass
        try:
            con.execute('PRAGMA wal_checkpoint(PASSIVE)')
        except sqlite3.OperationalError:
            pass
        return {'updated': result, 'stats': stats(con, db_path)}
    finally:
        os.close(lock)


# --------------------------------------------------------------------------------------------
# Output and CLI

def shrink(obj, budget=MAX_OUTPUT):
    text = dumps(obj)
    limit = 4000
    while len(text) > budget and limit >= 60:
        obj = _cut_strings(obj, limit)
        text = dumps(obj)
        limit //= 2
    return text


def _cut_strings(obj, limit):
    if isinstance(obj, str):
        return clip(obj, limit)
    if isinstance(obj, dict):
        return {k: _cut_strings(v, limit) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_cut_strings(v, limit) for v in obj]
    return obj


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise RecallError(message)


def build_cli():
    p = _Parser(prog='recall.py', description='Search past coding-agent sessions (JSON out).')
    p.add_argument('--db', help='index database (default <home>/.claude/recall/index.db)')
    p.add_argument('--home', help='home folder to read sessions from (default $HOME)')
    sp = p.add_subparsers(dest='command', parser_class=_Parser)

    u = sp.add_parser('update', help='index new and changed sessions')
    u.add_argument('--sources', help='comma list of ' + ','.join(SOURCES))
    u.add_argument('--subagents', action='store_true', help='also index subagent transcripts')
    u.add_argument('--prune-deleted', action='store_true', help='drop docs of transcripts that no longer exist')
    u.add_argument('--retention-days', type=float, help='drop docs older than this many days (notes stay)')
    u.add_argument('--max-seconds', type=float, help='stop early (resumable) after this many seconds')
    u.add_argument('--progress', action='store_true', help='JSON progress lines on stderr')
    u.add_argument('--rebuild', action='store_true', help='re-read every file from the start (notes stay)')

    s = sp.add_parser('search', help='full-text search')
    s.add_argument('--query', '-q', required=True)
    s.add_argument('--project')
    s.add_argument('--boost-project')
    s.add_argument('--exclude-session')
    s.add_argument('--kinds')
    s.add_argument('--since')
    s.add_argument('--until')
    s.add_argument('--limit', type=int, default=8)
    s.add_argument('--routines', default='include')
    s.add_argument('--source', default='all')
    s.add_argument('--half-life-days', type=float, default=45.0)

    e = sp.add_parser('expand', help='docs around one hit')
    e.add_argument('--ref', required=True)
    e.add_argument('--before', type=int, default=4)
    e.add_argument('--after', type=int, default=4)
    e.add_argument('--max-chars', type=int, default=6000)

    r = sp.add_parser('recap', help='what happened in recent sessions')
    r.add_argument('--project')
    r.add_argument('--session')
    r.add_argument('--exclude-session')
    r.add_argument('--count', type=int, default=1)
    r.add_argument('--routines', default='include')

    t = sp.add_parser('timeline', help='sessions by day')
    t.add_argument('--project')
    t.add_argument('--since', default='14d')
    t.add_argument('--limit', type=int, default=60)
    t.add_argument('--routines', default='include')

    li = sp.add_parser('list', help='docs of one kind, newest first')
    li.add_argument('--kind', required=True)
    li.add_argument('--query')
    li.add_argument('--project')
    li.add_argument('--since')
    li.add_argument('--until')
    li.add_argument('--limit', type=int, default=20)
    li.add_argument('--include-inspect', action='store_true', help='with --kind command: also read-only commands')

    n = sp.add_parser('note', help='notes kept only in the index')
    nsp = n.add_subparsers(dest='note_action', parser_class=_Parser)
    na = nsp.add_parser('add')
    na.add_argument('--text', required=True)
    na.add_argument('--project')
    nl = nsp.add_parser('list')
    nl.add_argument('--project')
    nl.add_argument('--limit', type=int, default=50)
    nf = nsp.add_parser('forget')
    nf.add_argument('--ref', required=True)

    f = sp.add_parser('forget', help='remove sessions, a project or old docs and keep them out')
    f.add_argument('--session')
    f.add_argument('--project')
    f.add_argument('--before')

    sp.add_parser('projects', help='known projects')
    sp.add_parser('stats', help='index statistics')
    sp.add_parser('remask', help='re-apply secret masking (redaction literals) to everything stored')
    return p


def main(argv=None) -> int:
    try:
        args = build_cli().parse_args(argv)
        if not args.command:
            raise RecallError('a command is required: update, search, expand, recap, timeline, list, note, forget, '
                              'projects, stats, remask')
        if args.command == 'note' and not getattr(args, 'note_action', None):
            raise RecallError('note needs add, list or forget')
        home = os.path.abspath(os.path.expanduser(args.home or os.environ.get('HOME') or '~'))
        db_path = os.path.abspath(os.path.expanduser(args.db or os.path.join(home, '.claude', 'recall', 'index.db')))
        if args.command in ('update', 'note', 'remask', 'stats'):
            set_redaction(load_literals(home))  # values stay in memory only
        con = connect(db_path)
        try:
            c = args.command
            if c == 'update':
                out = cmd_update(con, args, db_path, home)
            elif c == 'search':
                out = cmd_search(con, args)
            elif c == 'expand':
                out = cmd_expand(con, args)
            elif c == 'recap':
                out = cmd_recap(con, args)
            elif c == 'timeline':
                out = cmd_timeline(con, args)
            elif c == 'list':
                out = cmd_list(con, args)
            elif c == 'note':
                out = cmd_note(con, args)
            elif c == 'forget':
                out = cmd_forget(con, args, db_path)
            elif c == 'projects':
                out = cmd_projects(con, args)
            elif c == 'stats':
                out = stats(con, db_path)
            elif c == 'remask':
                out = cmd_remask(con, args, db_path, home)
            else:
                raise RecallError('unknown command %s' % c)
        finally:
            con.close()
        sys.stdout.write(shrink(out) + '\n')
        return 0
    except RecallError as e:
        sys.stdout.write(dumps({'error': str(e)}) + '\n')
        return 1
    except sqlite3.Error as e:
        sys.stdout.write(dumps({'error': 'sqlite: %s' % e}) + '\n')
        return 1
    except Exception as e:  # never a traceback on stdout: the caller reads JSON
        sys.stdout.write(dumps({'error': '%s: %s' % (type(e).__name__, e)}) + '\n')
        return 1


if __name__ == '__main__':
    sys.exit(main())

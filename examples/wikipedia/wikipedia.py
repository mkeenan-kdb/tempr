#!/usr/bin/env python3
"""Live Wikipedia edits through tempr, on a local web page.

    python3 wikipedia.py                        # follow Wikimedia's public streams; open http://127.0.0.1:8000
    python3 wikipedia.py --record wiki.jsonl    # ...and keep the events for replay
    python3 wikipedia.py --replay wiki.jsonl    # replay recorded events, as fast as --speed says

Sealed minutes are exported to wikipedia-archive/edits/*.csv with every version of every edit, so the
history outlives tempr's memory: query it with DuckDB, Polars or anything that reads CSV.

Every Wikimedia wiki reports each edit within a second or two: about twenty a second across all
of them. Some edits are later reverted, often within minutes, and a second stream reports that.
tempr counts edits per minute as they arrive, and when an edit is reverted it corrects that edit,
so the minute it was made in, already in the past, changes. The page shows both as they happen,
and lets you look back at what was known at any moment of the last hour.

Standard library only; needs Python 3.8+ and the tempr binary (the package's bin/tempr is found
automatically, or pass --tempr).
"""
import argparse, collections, hashlib, http.server, json, pathlib, queue, re, subprocess, sys, threading, time
import urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

STREAMS = {'rc': 'https://stream.wikimedia.org/v2/stream/mediawiki.recentchange',
           'tags': 'https://stream.wikimedia.org/v2/stream/mediawiki.revision-tags-change'}
AGENT = 'tempr-demo/0.1 (https://github.com/mkeenan-kdb/tempr)'  # Wikimedia asks clients to say who they are
HERE = pathlib.Path(__file__).resolve().parent
MIN = 60_000
LAG, GRACE = 2 * MIN, 30 * MIN  # watermark lag; how long a minute accepts corrections

# A minute window takes new edits until the watermark (two minutes behind) passes its end, accepts
# reverts for 30 minutes more, then seals. Every 30 seconds the demo exports sealed minutes to CSV
# (every version of every edit); with export: hold a minute leaves memory only once exported, an hour
# after sealing. Memory stays bounded, and the archive keeps everything.
SCHEMA = """\
type Edit = {id: Int64, time: Timestamp, wiki: Symbol, bot: Int64, reverted: Int64, bytes: Int64}
stream edits: Edit {id: id, time: time, window: tumble(1m, origin = UTC_midnight),
  allow_lateness: 0s, correction_grace: 30m, history_after_seal: 1h, future_skew: 1m,
  max_pending: 100000, on_late: reject, on_closed_correction: reject,
  cursor: knowledge, watermark: explicit, export: hold}
view per_minute = edits |> tumble 1m on time |> group window
  |> aggregate edits = count(), bots = sum(bot), reverted = sum(reverted), bytes = sum(bytes)
view wikis = edits |> group wiki |> aggregate edits = count(), bots = sum(bot), reverted = sum(reverted)
"""
STATEMENTS = 4  # type, stream and two views
QUERY_WORDS = ('per_minute', 'wikis', 'show', 'help', 'explain', 'dependencies', 'inspect')


def ms(iso):
    return int(datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp() * 1000)


def ts(t):
    return datetime.fromtimestamp(t / 1000, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3]


def edit_id(wiki, rev):
    """tempr ids are Int64; revision ids are only unique within one wiki."""
    return int.from_bytes(hashlib.sha256(f'{wiki}:{rev}'.encode()).digest()[:8], 'big') >> 1


def trim(stream, e):
    """The fields the demo uses, or None for events it ignores."""
    if stream == 'rc':
        if e.get('type') not in ('edit', 'new') or 'revision' not in e:
            return None
        ln = e.get('length') or {}
        return {'s': 'rc', 'dt': e['meta']['dt'], 'wiki': e['wiki'], 'domain': e['meta']['domain'],
                'rev': e['revision']['new'], 'title': e['title'], 'bot': bool(e.get('bot')),
                'bytes': (ln.get('new') or 0) - (ln.get('old') or 0)}
    before = (e.get('prior_state') or {}).get('tags') or []
    if 'mw-reverted' not in (e.get('tags') or []) or 'mw-reverted' in before:
        return None  # only the moment an edit becomes reverted
    return {'s': 'tags', 'dt': e['meta']['dt'], 'wiki': e['database'], 'domain': e['meta']['domain'],
            'rev': e['rev_id'], 'title': e['page_title'], 'edited': e['rev_timestamp']}


def sse(url):
    """Events from a server-sent-event stream, reconnecting when it drops. Python from python.org
    on macOS has no CA certificates until its 'Install Certificates' script runs; then curl is used."""
    while True:
        try:
            try:
                req = urllib.request.Request(url, headers={'Accept': 'text/event-stream', 'User-Agent': AGENT})
                lines = (l.decode() for l in urllib.request.urlopen(req, timeout=60))
                yield from parse_sse(lines)
            except urllib.error.URLError as e:
                if 'CERTIFICATE_VERIFY_FAILED' not in str(e):
                    raise
                p = subprocess.Popen(['curl', '-sSN', '-A', AGENT, '-H', 'Accept: text/event-stream', url],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                yield from parse_sse(p.stdout)
        except Exception as e:  # a dropped stream: reconnect
            print('stream dropped:', e, file=sys.stderr)
        time.sleep(2)


def parse_sse(lines):
    for line in lines:
        if line.startswith('data: {'):
            try:
                yield json.loads(line[6:])
            except ValueError:
                pass  # a line split by the network; skip it


class Tempr:
    """One tempr --json process. Calls are serialised: the engine is single-threaded."""

    def __init__(self, exe, data, on_watch):
        self.p = subprocess.Popen([exe, '--data', data, '--json'], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, text=True, encoding='utf-8', bufsize=1)
        self.lock, self.on_watch = threading.Lock(), on_watch

    def ask(self, text, statements=1):
        """Results of `statements` statements: tables and texts, ending with ok/error each."""
        with self.lock:
            self.p.stdin.write(text.rstrip('\n') + '\n')
            self.p.stdin.flush()
            out, done = [], 0
            while done < statements:
                line = self.p.stdout.readline()
                if not line:
                    raise RuntimeError('tempr exited; see its messages above')
                m = json.loads(line)
                if 'watch' in m:
                    self.on_watch(m)
                    continue
                out.append(m)
                done += 'ok' in m or 'error' in m
            return out

    def table(self, query):
        for m in self.ask(query):
            if 'error' in m:
                raise ValueError(m['error'])
            if 'rows' in m:
                return [dict(zip(m['columns'], r)) for r in m['rows']]
        return []


class Demo:
    def __init__(self, args):
        self.args, self.q = args, queue.Queue()
        self.edits = {}  # id -> (minute, wiki, domain, title, time), while reverts can still land
        self.reverts = collections.deque(maxlen=200)
        self.revised = {}  # minute -> knowledge time tempr last revised it after the minute ended
        self.known = self.first_known = None
        self.dropped = self.too_late = self.commits = 0
        self.archived = {'versions': 0, 'files': 0, 'through': None, 'error': None}
        self.rate = collections.deque(maxlen=10)  # (time, edits) per commit, for edits/s
        self.t = Tempr(args.tempr, args.data, self.on_watch)
        if 'stream edits' not in ''.join(m.get('text', '') for m in self.t.ask('show')):
            for m in self.t.ask(SCHEMA, STATEMENTS):  # a restart finds them in the catalog
                if 'error' in m:
                    sys.exit(f"tempr: {m['error']}")
        self.t.ask('watch per_minute')

    def on_watch(self, m):
        """tempr's published changes to per_minute: note past minutes that were revised."""
        k = ms(m['known'] + 'Z')
        for c in m['changes']:
            win = dict(zip(m['columns'], c['row']))['window']  # as tempr writes it: the page's key
            if c['op'] == 'update' and ms(win + 'Z') + MIN <= k - 5000:  # a minute already over
                self.revised[win] = m['known']

    def read(self, name):
        for e in sse(STREAMS[name]):
            t = trim(name, e)
            if t:
                self.q.put(t)

    def replay(self):
        prev = None
        for line in open(self.args.replay):
            e = json.loads(line)
            if prev is not None and self.args.speed:
                time.sleep(max(0, ms(e['dt']) - prev) / 1000 / self.args.speed)
            prev = ms(e['dt'])
            self.q.put(e)
        print('replay finished; still serving', file=sys.stderr)

    def commit_forever(self):
        rec = open(self.args.record, 'a') if self.args.record else None
        while True:
            time.sleep(1)
            batch = []
            while not self.q.empty():
                batch.append(self.q.get())
            if batch:
                if rec:
                    rec.writelines(json.dumps(e, separators=(',', ':')) + '\n' for e in batch)
                    rec.flush()
                self.apply(batch)
            if self.commits and self.commits % 30 == 0:
                self.export()

    def apply(self, batch):
        """One transaction: this second's edits and reverts. Knowledge time is the latest event's
        own time, so a replay reproduces what was known when."""
        k = max([self.known or 0] + [ms(e['dt']) for e in batch])
        wm = k - LAG
        stmts, rows, reverts, new_edits = [], [], [], {}
        for e in batch:
            t = ms(e['dt'])
            i = edit_id(e['wiki'], e['rev'])
            if e['s'] == 'rc':
                if t < wm or i in self.edits or i in new_edits:
                    self.dropped += 1  # behind the watermark (tempr: LATE), or a repeat
                    continue
                new_edits[i] = (t - t % MIN, e['wiki'], e['domain'], e['title'], t)
                rows.append(f"{{id: {i}, time: {ts(t)}, wiki: \"{e['wiki']}\", bot: {int(e['bot'])}, "
                            f"reverted: 0, bytes: {int(e['bytes'])}}}")
        if rows:
            stmts.append('insert edits [' + ', '.join(rows) + ']')
        for e in batch:
            i = edit_id(e['wiki'], e['rev'])
            if e['s'] != 'tags':
                continue
            ed = self.edits.get(i) or new_edits.get(i)
            if not ed:
                continue  # an edit made before we started watching
            if ed[0] + MIN + GRACE <= wm:
                self.too_late += 1  # its minute has sealed: tempr would refuse the change
                continue
            stmts.append(f'correct edits {i} rev 1 {{reverted: 1}}')
            reverts.append({'wiki': ed[1], 'domain': ed[2], 'title': ed[3], 'rev': e['rev'],
                            'edited': ts(ed[4]), 'minute': ts(ed[0]), 'known': ts(k),
                            'after_s': round((k - ed[4]) / 1000)})
            self.edits.pop(i, None)
            new_edits.pop(i, None)  # reverted once; a second report would need rev 2
        text = '\n'.join([f'clock {ts(k)}', 'begin', *stmts,
                          f'advance edits watermark {ts(wm)}', 'commit'])
        res = self.t.ask(text, len(stmts) + 4)
        errors = [m['error'] for m in res if 'error' in m]
        if errors:  # the transaction failed as a whole
            print('tempr refused a batch:', *errors[:3], sep='\n  ', file=sys.stderr)
            self.t.ask('abort')
            return
        self.edits.update(new_edits)
        for i in [i for i, ed in self.edits.items() if ed[0] + MIN + GRACE <= wm]:
            del self.edits[i]  # sealed: no revert can change it now
        self.reverts.extend(reverts)
        self.known, self.first_known = k, self.first_known or k
        self.commits += 1
        self.rate.append((time.monotonic(), len(rows)))

    def export(self):
        """Sealed minutes to the archive: tempr writes every version, then lets them retire."""
        d = self.args.archive.replace('\\', '\\\\').replace('"', '\\"')
        for m in self.t.ask(f'export edits to "{d}"'):
            t = re.match(r'exported (\d+) versions? of \w+, windows .* to (\S+), to ', m.get('text', ''))
            if t:
                self.archived['versions'] += int(t[1])
                self.archived['files'] += 1
                self.archived['through'] = t[2]
            elif 'windows to ' in m.get('text', ''):
                self.archived['through'] = m['text'].split('windows to ')[1].split()[0]
            self.archived['error'] = m.get('error')

    def state(self, known_at=None):
        """What the page shows, as known now or at an earlier knowledge time; all three queries
        at one knowledge time, so a commit between them cannot mix them."""
        known_at = known_at or (self.known and ts(self.known))
        if not known_at:
            return {'waiting': True, 'replay': bool(self.args.replay)}
        k = f' known_at {known_at}'
        r = list(self.rate)
        eps = sum(n for _, n in r[1:]) / (r[-1][0] - r[0][0]) if len(r) > 1 and r[-1][0] > r[0][0] else 0
        try:
            minutes = self.t.table('per_minute' + k)[-40:]
            wikis = sorted(self.t.table('wikis' + k), key=lambda w: -w['edits'])
        except ValueError as e:
            return {'error': str(e)}
        total = {c: sum(w[c] for w in wikis) for c in ('edits', 'bots', 'reverted')}  # tempr's totals
        return {'minutes': minutes, 'wikis': wikis[:15], 'total': total,
                'reverts': list(self.reverts)[-60:], 'revised': self.revised, 'known_at': known_at,
                'first_known': ts(self.first_known), 'last_known': ts(self.known),
                'eps': round(eps, 1), 'commits': self.commits, 'archive': self.args.archive,
                'archived': self.archived, 'too_late': self.too_late,
                'replay': bool(self.args.replay)}


def serve(demo, port):
    class Handler(http.server.BaseHTTPRequestHandler):
        def send(self, code, body, kind='application/json'):
            b = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            if u.path == '/':
                self.send(200, (HERE / 'index.html').read_bytes(), 'text/html; charset=utf-8')
            elif u.path == '/api/state':
                self.send(200, demo.state(urllib.parse.parse_qs(u.query).get('known_at', [None])[0]))
            else:
                self.send(404, {'error': 'not found'})

        def do_POST(self):  # the query box: read-only statements only
            if self.path != '/api/query':
                return self.send(404, {'error': 'not found'})
            text = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode().strip()
            if '\n' in text or ';' in text or text.split(' ', 1)[0] not in QUERY_WORDS:
                return self.send(400, {'error': 'one query: per_minute or wikis, with optional '
                                                'at/known_at, or show, explain, inspect'})
            self.send(200, demo.t.ask(text))

        def log_message(self, *a):
            pass

    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'tempr wikipedia: http://127.0.0.1:{port}  (data in {demo.args.data})', file=sys.stderr)
    httpd.serve_forever()


def find_tempr():
    for p in (HERE.parent.parent / 'bin' / 'tempr', HERE.parent.parent / 'build' / 'tempr-release'):
        if p.exists():
            return str(p)
    return 'tempr'


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--tempr', default=find_tempr(), help='the tempr binary (default: %(default)s)')
    ap.add_argument('--data', default='wikipedia-data', help='tempr data directory (default: %(default)s)')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--archive', default='wikipedia-archive',
                    help='where sealed minutes are exported as CSV (default: %(default)s)')
    g = ap.add_mutually_exclusive_group()
    g.add_argument('--replay', help='JSONL of recorded events instead of the live streams')
    g.add_argument('--record', help='append every event used to this JSONL file')
    ap.add_argument('--speed', type=float, default=1, help='replay speed; 0: as fast as possible')
    args = ap.parse_args()
    demo = Demo(args)
    if args.replay:
        threading.Thread(target=demo.replay, daemon=True).start()
    else:
        for name in STREAMS:
            threading.Thread(target=demo.read, args=(name,), daemon=True).start()
    threading.Thread(target=demo.commit_forever, daemon=True).start()
    serve(demo, args.port)


if __name__ == '__main__':
    main()

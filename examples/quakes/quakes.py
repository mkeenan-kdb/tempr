#!/usr/bin/env python3
"""Live USGS earthquakes through tempr, on a local web page.

    python3 quakes.py                          # poll USGS every minute; open http://127.0.0.1:8000
    python3 quakes.py --replay recorded.jsonl  # replay recorded feed snapshots quickly
    python3 quakes.py --record recorded.jsonl  # poll, and keep each snapshot for replay

USGS publishes every earthquake it detects within minutes, then revises it: seismologists
review the automatic magnitude and location, and delete false detections. The feed shows
only each quake's latest version. tempr keeps every version, so the page can show what was
known at any earlier moment, and every revision as it happens.

Each feed snapshot becomes one tempr transaction: new quakes are inserted, changed ones
corrected, vanished ones deleted. Knowledge time is the snapshot's own `generated` time, so a
replay reproduces what was known when. Needs Python 3.8+ and the tempr binary: the package's
bin/tempr is found automatically, or pass --tempr. Standard library only.
"""
import argparse, hashlib, http.server, json, pathlib, subprocess, sys, threading, time
import urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson'
HERE = pathlib.Path(__file__).resolve().parent
HOUR_MS = 3_600_000

# The watermark trails the feed by 26 hours: the day feed never shows older quakes, so their
# hourly windows can seal, and retire a week later. That bounds memory for a long run.
SCHEMA = """\
type Quake = {id: Int64, time: Timestamp, code: Symbol, region: Symbol, place: Symbol,
  mag: Float64?, depth: Float64, lat: Float64, lon: Float64, status: Symbol, version: Int64}
stream quakes: Quake {id: id, time: time, window: tumble(1h, origin = UTC_midnight),
  allow_lateness: 1h, correction_grace: 1h, history_after_seal: 7d, future_skew: 1h,
  max_pending: 10000, on_late: reject, on_closed_correction: reject,
  cursor: knowledge, watermark: explicit}
view latest = quakes
view regions = quakes |> group region |> aggregate n = count(), avg_mag = avg(mag)
view hourly = quakes |> tumble 1h on time |> group window |> aggregate n = count(), avg_mag = avg(mag)
"""
STATEMENTS = 5
VIEWS = ('latest', 'regions', 'hourly')
QUERY_WORDS = VIEWS + ('show', 'help', 'explain', 'dependencies', 'inspect')


def ts(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3]


def lit(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', ' ') + '"'


def fetch(url):
    """The feed. Python from python.org on macOS has no CA certificates until its
    'Install Certificates' script runs; curl verifies with the system's."""
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.load(r)
    except urllib.error.URLError as e:
        if 'CERTIFICATE_VERIFY_FAILED' not in str(e):
            raise
        return json.loads(subprocess.run(['curl', '-sSf', '--max-time', '30', url], check=True,
                                         capture_output=True, text=True).stdout)


def event_id(code):
    """tempr ids are Int64; USGS ids are strings such as ak0251ab2c. Stable across restarts."""
    return int.from_bytes(hashlib.sha256(code.encode()).digest()[:8], 'big') >> 1


def region(place):
    """'45 km NNW of Valdez, Alaska' -> 'Alaska'; 'CA' -> 'California'."""
    r = (place or 'Unknown').rsplit(', ', 1)[-1].strip()
    return {'CA': 'California', 'NV': 'Nevada', 'B.C., MX': 'Baja California'}.get(r, r)


def fields(f):
    """The row tempr stores for a feed feature (without version)."""
    p, c = f['properties'], f['geometry']['coordinates']
    return {'time': p['time'], 'code': f['id'], 'region': region(p['place']),
            'place': p['place'] or 'Unknown', 'mag': p['mag'], 'depth': c[2], 'status': p['status'],
            'lat': c[1], 'lon': c[0]}


def row(q, version):
    mag = 'null' if q['mag'] is None else repr(float(q['mag']))
    return (f"time: {ts(q['time'])}, code: {lit(q['code'])}, region: {lit(q['region'])}, "
            f"place: {lit(q['place'])}, mag: {mag}, depth: {float(q['depth'])!r}, "
            f"lat: {float(q['lat'])!r}, lon: {float(q['lon'])!r}, status: {lit(q['status'])}, "
            f"version: {version}")


STORED = ('time', 'code', 'region', 'place', 'mag', 'depth', 'lat', 'lon', 'status')


def changes(known, snapshot):
    """Statements that take tempr from `known` (code -> {version, fields}) to the snapshot.

    Returns (statements, known after). A quake missing from the snapshot was deleted by USGS,
    unless it simply aged out of the 24-hour feed.
    """
    gen = snapshot['metadata']['generated']
    now = {f['id']: fields(f) for f in snapshot['features']}
    out, after = [], dict(known)
    for code, q in now.items():
        k = known.get(code)
        if k is None:
            out.append(f"insert quakes {{id: {event_id(code)}, {row(q, 1)}}}")
            after[code] = {'version': 1, **q}
        elif any(k[c] != q[c] for c in STORED):
            v = k['version']
            out.append(f"correct quakes {event_id(code)} rev {v} {{{row(q, v + 1)}}}")
            after[code] = {'version': v + 1, **q}
    for code, k in known.items():
        if code not in now and k['time'] > gen - 24 * HOUR_MS + 5 * 60_000:
            out.append(f"delete quakes {event_id(code)} rev {k['version']}")
            del after[code]
        elif code not in now:
            del after[code]  # aged out: tempr keeps it; we just stop tracking it
    return out, after


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
        self.args, self.revisions, self.first_known, self.last_known = args, [], None, None
        self.polls, self.error = 0, None
        self.t = Tempr(args.tempr, args.data, self.on_watch)
        if 'stream quakes' not in ''.join(m.get('text', '') for m in self.t.ask('show')):
            for m in self.t.ask(SCHEMA, STATEMENTS):  # a restart finds them in the catalog
                if 'error' in m:
                    sys.exit(f"tempr: {m['error']}")
        self.known = {}  # what tempr holds, rebuilt from it after a restart
        for r in self.t.table('latest'):
            self.known[r['code']] = {'version': r['version'], **{c: r[c] for c in STORED}}
            self.known[r['code']]['time'] = parse_ms(r['time'])
        self.t.ask('watch latest')

    def on_watch(self, m):
        """Every change tempr publishes to the latest view: keep the revisions for the page."""
        cols = m['columns']
        for c in m['changes']:
            if c['op'] == 'insert':
                continue
            new, old = dict(zip(cols, c['row'])), dict(zip(cols, c.get('old', c['row'])))
            what = [f"{k} {old[k]} → {new[k]}" for k in ('mag', 'status', 'depth', 'place') if old[k] != new[k]]
            if c['op'] == 'delete':
                what = ['deleted by USGS']
            self.revisions.append({'known': m['known'], 'commit': m['commit'], 'code': new['code'],
                                   'place': new['place'], 'mag': new['mag'], 'op': c['op'], 'what': what})
        del self.revisions[:-500]

    def apply(self, snapshot):
        gen = snapshot['metadata']['generated']
        if self.last_known and gen <= self.last_known:
            return  # a cached copy of a snapshot already applied
        stmts, after = changes(self.known, snapshot)
        text = '\n'.join([f'clock {ts(gen)}', 'begin', *stmts,
                          f'advance quakes watermark {ts(gen - 26 * HOUR_MS)}', 'commit'])
        res = self.t.ask(text, len(stmts) + 4)
        errors = [m['error'] for m in res if 'error' in m]
        if errors:  # the transaction aborted as a whole; resync from tempr's own state
            print('tempr refused a snapshot:', *errors[:3], sep='\n  ', file=sys.stderr)
            self.t.ask('abort')
            return
        self.known = after
        self.first_known = self.first_known or gen
        self.last_known, self.polls = gen, self.polls + 1
        if self.args.record:  # only what apply reads: about a quarter of the feed's size
            keep = {'metadata': {'generated': gen}, 'features': [
                {'id': f['id'], 'geometry': {'coordinates': f['geometry']['coordinates']},
                 'properties': {k: f['properties'][k] for k in ('time', 'mag', 'place', 'status')}}
                for f in snapshot['features']]}
            with open(self.args.record, 'a') as f:
                f.write(json.dumps(keep, separators=(',', ':')) + '\n')

    def poll_forever(self):
        if self.args.replay:
            for line in open(self.args.replay):
                self.apply(json.loads(line))
                time.sleep(self.args.interval)
            print('replay finished; still serving', file=sys.stderr)
            return
        while True:
            try:
                self.apply(fetch(FEED))
                self.error = None
            except Exception as e:  # keep serving: the next poll may work
                self.error = str(e)
                print('poll failed:', e, file=sys.stderr)
            time.sleep(self.args.interval)

    def state(self, known_at=None):
        """What the page shows, as known now or at an earlier knowledge time. Pinned to one
        knowledge time, so a poll committing between the three queries cannot mix them."""
        known_at = known_at or (self.last_known and ts(self.last_known))
        k = f' known_at {known_at}' if known_at else ''
        try:
            return {'quakes': self.t.table('latest' + k), 'regions': self.t.table('regions' + k),
                    'hourly': self.t.table('hourly' + k), 'revisions': self.revisions[-200:],
                    'first_known': self.first_known and ts(self.first_known),
                    'last_known': self.last_known and ts(self.last_known),
                    'polls': self.polls, 'error': self.error, 'replay': bool(self.args.replay)}
        except ValueError as e:
            return {'error': str(e)}


def parse_ms(s):
    return int(datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp() * 1000)


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
            path, _, q = self.path.partition('?')
            if path == '/':
                self.send(200, (HERE / 'index.html').read_bytes(), 'text/html; charset=utf-8')
            elif path == '/api/state':
                ka = dict(p.split('=', 1) for p in q.split('&') if '=' in p).get('known_at')
                self.send(200, demo.state(ka and urllib.parse.unquote(ka)))
            else:
                self.send(404, {'error': 'not found'})

        def do_POST(self):  # the query box: read-only statements only
            if self.path != '/api/query':
                return self.send(404, {'error': 'not found'})
            text = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode().strip()
            if '\n' in text or ';' in text or text.split(' ', 1)[0] not in QUERY_WORDS:
                return self.send(400, {'error': 'one query: a view (' + ', '.join(VIEWS) +
                                        ') with optional at/known_at, or show, explain, inspect'})
            self.send(200, demo.t.ask(text))

        def log_message(self, *a):
            pass

    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'tempr quakes: http://127.0.0.1:{port}  (data in {demo.args.data})', file=sys.stderr)
    httpd.serve_forever()


def find_tempr():
    for p in (HERE.parent.parent / 'bin' / 'tempr', HERE.parent.parent / 'build' / 'tempr-release'):
        if p.exists():
            return str(p)
    return 'tempr'


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--tempr', default=find_tempr(), help='the tempr binary (default: %(default)s)')
    ap.add_argument('--data', default='quakes-data', help='tempr data directory (default: %(default)s)')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--interval', type=float, help='seconds between polls (default 60; 1 for --replay)')
    g = ap.add_mutually_exclusive_group()
    g.add_argument('--replay', help='JSONL of recorded feed snapshots instead of polling USGS')
    g.add_argument('--record', help='append each polled snapshot to this JSONL file')
    args = ap.parse_args()
    args.interval = args.interval if args.interval is not None else 1 if args.replay else 60
    demo = Demo(args)
    threading.Thread(target=demo.poll_forever, daemon=True).start()
    serve(demo, args.port)


if __name__ == '__main__':
    main()

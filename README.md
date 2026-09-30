# tempr

**Live analytics for data that changes.**

[![Release](https://img.shields.io/badge/release-v0.3.0-blue.svg)](https://github.com/mkeenan-kdb/tempr/releases)
[![Docs](https://img.shields.io/badge/docs-reference-emerald.svg)](https://mkeenan-kdb.github.io/tempr/)

tempr is a small, embeddable C11 engine. Define a view once, then send it events. It keeps the answer up to date as events arrive late, are corrected or are deleted, and it can tell you what the answer was before each change: `vwap at T known_at K`, "for events up to T, what did we believe at K?"

It is one binary and one C library, with no server to run and nothing else to install.

## Watch it work

Download the package for your platform (see [Install](#install)), then:

```sh
python3 examples/wikipedia/wikipedia.py      # then open http://127.0.0.1:8000
```

It follows every Wikipedia edit as it happens, about 20 to 30 a second, and counts them per minute. When an edit is reverted, often seconds or minutes later, tempr corrects it, and a minute already in the past changes on screen. Drag the time slider back to see any minute exactly as it was known then. Sealed minutes are exported to CSV files that answer the same questions. A second demo follows USGS earthquakes, which seismologists revise over hours ([live demos](https://mkeenan-kdb.github.io/tempr/#doc/live-demo)).

## Where it fits

tempr is the hot tier: the recent data that is still changing, held in memory inside the program that needs it. Long history belongs in a store built for it.

```text
feeds, Kafka ──► tempr, in your process ─────────► archive: files, lake, historical DB
                 live views, corrections,           every version of every sealed
                 as-of joins, subscribers,          window, as CSV; "as known at"
                 "as known at" over recent history  keeps working there
```

It suits workloads where the recent answer must be right now, and cheap to keep right, as data arrives late or is corrected: intraday trading analytics, enrichment against the prevailing quote, metering and billing, operational metrics, point-in-time features. It does not suit terabyte-scale history, ad-hoc exploration or many-to-many joins, and it has no replication: for failover, replay from a durable upstream such as Kafka.

## Install

Packages for `macos-arm64`, `linux-x86_64` and `linux-arm64` are on the [releases page](https://github.com/mkeenan-kdb/tempr/releases), with `SHA256SUMS`. The Linux packages need glibc 2.34 or later (Ubuntu 22.04+, Debian 12+, RHEL 9+, Amazon Linux 2023).

```sh
curl -LO https://github.com/mkeenan-kdb/tempr/releases/download/v0.3.0/tempr-0.3.0-macos-arm64.tar.gz
tar -xzf tempr-0.3.0-macos-arm64.tar.gz && cd tempr-0.3.0-macos-arm64
./bin/tempr --help
```

Each package has the command-line program (`bin/tempr`), the C header (`include/tempr.h`), static and shared libraries with a pkg-config file (`lib/`), and the examples (`examples/`).

## Three ways to use it

**Interactively.** Run `./bin/tempr` and paste:

```tempr
date 2026-09-28
type Trade = {id: Int64, event_time: Timestamp, sym: Symbol, price: Float64, size: Int64}
stream trades: Trade {
  id: id, time: event_time, window: tumble(1h, origin = UTC_midnight),
  allow_lateness: 2m, correction_grace: 10m, history_after_seal: 7d, future_skew: 1h,
  max_pending: 1000, on_late: reject, on_closed_correction: reject,
  cursor: knowledge, watermark: explicit
}
view vwap = trades
  |> tumble 1h on event_time
  |> group window, sym
  |> aggregate volume = sum(size), turnover = sum(price * size)
  |> derive value = turnover / volume

clock 10:00:00
insert trades {id: 1, event_time: 10:00:00, sym: `AAPL, price: 200, size: 100}
clock 10:00:01
insert trades {id: 2, event_time: 10:00:01, sym: `AAPL, price: 202, size: 100}
vwap                                   # 201

clock 10:05:00
correct trades 2 rev 1 {price: 204}   # trade 2 should have been 204
vwap                                   # 202
vwap at 10:00:01 known_at 10:01:00     # what we showed before the correction: 201
```

**From another program.** Pipe statements in and read one JSON object per line back. Each statement runs as it arrives, so the pipe can stay open. `--data` makes it durable: after a restart, the same command recovers.

```sh
my_feed | ./bin/tempr --data ./store --json setup.tr -i
```

**Inside your program.** Link `libtempr.a`, pass events as C structs and subscribe to view changes, with no serialization and no network hop:

```sh
cc -std=c11 -O2 -Iinclude examples/live_vwap.c lib/libtempr.a -lm -o live_vwap && ./live_vwap
```

```text
commit 1: VWAP 200.00
commit 2: VWAP 204.00
as known before the correction: 200.00
```

## Keep the history

A window seals once it can no longer change. Export writes every version of every event in newly sealed windows to CSV, with the knowledge time each version was known from and until. With `export: hold` in the stream's policy, nothing leaves memory until it has been exported.

```tempr
export trades to "archive"
```

```sql
-- DuckDB: the archive answers "as known at" too
SELECT id, sym, price FROM read_csv('archive/trades/*.csv')
WHERE _known <= TIMESTAMP '2026-09-28 10:03'
  AND (_until IS NULL OR _until > TIMESTAMP '2026-09-28 10:03') AND NOT _deleted;
```

## Performance

Recorded on Apple M2, 2026-09-29, against DuckDB, Polars, SQLite and pandas, with every answer checked against an independent reference:

| Test | tempr |
| --- | ---: |
| Keeping an as-of join up to date through late quotes, corrections and deletes: slowest 1% of 1,000-operation batches, over 2.5M operations | **0.802 ms** |
| Live VWAP with corrections and deletes | **10.25M ops/sec** |
| Live VWAP, append-only | 11.85M ops/sec |
| Durable, 1 MB group commit | 2.64M ops/sec |

tempr's cost per change stays flat as history grows, which is where it wins most. Where another engine is faster, the [benchmarks page](https://mkeenan-kdb.github.io/tempr/#doc/08-benchmarks) says so, with the method and limits.

## Documentation

- [Build your first system](https://mkeenan-kdb.github.io/tempr/#doc/first-system): a stream, a live VWAP, a correction, time travel and a restart, in ten minutes
- [Time-travel demo](https://mkeenan-kdb.github.io/tempr/#explorer): the engine's answers at every point in event and knowledge time
- [Language reference](https://mkeenan-kdb.github.io/tempr/#doc/04-dsl-reference) and [C API](https://mkeenan-kdb.github.io/tempr/#doc/05-c-api-reference)
- [Running your system](https://mkeenan-kdb.github.io/tempr/#doc/11-operations): retention, export, backpressure and recovery

## Status

Experimental, shared so people can try it. It is single-threaded (serialize your calls), keeps retained history in memory, and has no replication. The API and disk format may change before 1.0, with no automatic upgrade of data files; see [release and compatibility](https://mkeenan-kdb.github.io/tempr/#doc/release). It has been tested for correctness and recovery, but not yet run for days on production hardware.

Tell us what you build, and what gets in the way: [open an issue](https://github.com/mkeenan-kdb/tempr/issues). For bugs, include your platform, the smallest input that shows the problem, and what you expected.

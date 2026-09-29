# tempr

**An embedded C11 engine for live incremental analytics over changing event data.**

[![Release](https://img.shields.io/badge/release-v0.1.0-blue.svg)](https://github.com/mkeenan-kdb/tempr/releases)
[![Docs](https://img.shields.io/badge/docs-reference-emerald.svg)](https://mkeenan-kdb.github.io/tempr/)

Send it events, define views, and tempr keeps calculations up to date incrementally—even when events arrive late, are amended, or are retracted. You can also reconstruct historical answers within retained coverage to ask what the system knew at any previous point in time.

- **Zero External Dependencies:** Self-contained C11 library and CLI. No runtime daemons, no background threads, no network ports.
- **Incremental Maintenance:** Maintains running VWAPs, rolling metrics, and multi-view aggregations by applying each change instead of recalculating from scratch.
- **Bi-Temporal Point-in-Time Auditing:** Reconstruct prior answers as they were known at any historical timestamp or commit (`at T known_at K`).
- **Streaming As-Of Joins:** Joins high-frequency trades to prevailing quotes and re-matches only the trades a late or corrected quote affects.
- **Durable Persistence:** Write-Ahead Log (WAL) with group commit, snapshots, checkpoints, and crash recovery.

---

## Documentation & Interactive Demos

Full guides, API specifications, and interactive simulators are available on the official documentation portal:

👉 **[https://mkeenan-kdb.github.io/tempr/](https://mkeenan-kdb.github.io/tempr/)**

- [Overview & Workflow Integrations](https://mkeenan-kdb.github.io/tempr/#doc/00-introduction)
- [Build Your First System (CLI Walkthrough)](https://mkeenan-kdb.github.io/tempr/#doc/first-system)
- [C API Reference & Declarations](https://mkeenan-kdb.github.io/tempr/#doc/05-c-api-reference)
- [Time-Travel Demo (answers computed by the engine)](https://mkeenan-kdb.github.io/tempr/#explorer)
- [Cross-Engine Benchmarks](https://mkeenan-kdb.github.io/tempr/#doc/08-benchmarks)

---

## Performance at a Glance

Recorded on Apple M2, 2026-09-29. VWAP rows: 100,000 Binance ETHBTC trades in batches of 500, median of 3 runs. Join row: 2.5M operations in batches of 1,000.

| Mode | Throughput / Latency | Description |
| --- | ---: | --- |
| **Maintained VWAP** | **11.85M ops/sec** | Append-only streaming aggregation |
| **Corrections & Retractions** | **10.25M ops/sec** | Mixed stream with amendments and deletes |
| **Durable Group Commit** | **2.64M ops/sec** | Flushed to the device before acknowledging (1 MB group commit) |
| **Maintained As-Of Join** | **0.802 ms batch p99** | 2.5M quotes, trades, corrections and deletes; 0.985 s in total |

*See [Benchmarks](https://mkeenan-kdb.github.io/tempr/#doc/08-benchmarks) for complete methodology, hardware configuration, and comparisons against kdb+, DuckDB, SQLite, Polars, and pandas.*

---

## Installation

### 1. Download Pre-Built Binaries

Download official standalone release packages from [Releases](https://github.com/mkeenan-kdb/tempr/releases): `macos-arm64`, `linux-x86_64` and `linux-arm64`. The Linux packages need glibc 2.34+ (Ubuntu 22.04+, Debian 12+, RHEL 9+, Amazon Linux 2023).

```sh
# Example: macOS ARM64 (Apple Silicon); substitute your platform
curl -LO https://github.com/mkeenan-kdb/tempr/releases/download/v0.1.0/tempr-0.1.0-macos-arm64.tar.gz
tar -xzf tempr-0.1.0-macos-arm64.tar.gz
cd tempr-0.1.0-macos-arm64/
```

Package contents:
- `bin/tempr`: Standalone CLI program & interactive REPL
- `include/tempr.h`: Public C11 API header
- `lib/libtempr.a`: Static C library
- `lib/libtempr.0.dylib` (or `.so`): Shared C library
- `lib/pkgconfig/tempr.pc`: pkg-config definition
- `examples/wikipedia/`, `examples/quakes/`: live demos on local web pages: `python3 examples/wikipedia/wikipedia.py`

### 2. Verify Binary

```sh
./bin/tempr --help
```

---

## Quickstart

### Option A: CLI Interactive REPL

Launch an interactive session:
```sh
./bin/tempr
```

Paste these statements to create an hourly VWAP view, feed two trades, and query the answer:
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

# Inspect current VWAP (201.0)
vwap

# Correct Trade 2 price from 202 to 204
clock 10:05:00
correct trades 2 rev 1 {price: 204}

# Latest VWAP updates to 202.0:
vwap

# Query what the VWAP was before the correction arrived:
vwap at 10:00:01 known_at 10:01:00
```

### Option B: Embedded C Application

Compile against `libtempr.a`:
```sh
cc -std=c11 -O2 -Iinclude examples/live_vwap.c lib/libtempr.a -lm -o live_vwap
./live_vwap
```

Output:
```text
commit 1: VWAP 200.00
commit 2: VWAP 204.00
as known before the correction: 200.00
```

---

## Architectural Workflows

1. **Embedded In-Process Analytics (C / C++):** Link `libtempr.a` directly into your order router or feed handler and process events without network hops or serialization.
2. **Streaming Event Enrichment (As-Of Joins):** Match trades with asynchronous quote streams as-of execution time, handling amendments and busts automatically.
3. **UNIX Pipeline / Microservice:** Stream newline-delimited statements into `tempr --data ./store` from Kafka, Python, or shell scripts.

---

## Status

Experimental. Binaries are shared for people to try, as-is. Feedback and bug reports are welcome via [issues](https://github.com/mkeenan-kdb/tempr/issues).

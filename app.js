/* ==========================================================================
   tempr Documentation & Interactive Web Portal Application Logic
   ========================================================================== */

(function () {
  'use strict';

  // --- State ---
  let currentDocId = '00-introduction';
  let searchIndex = [];
  let currentExplorerStep = 1;

  // --- Document Category Mapping ---
  const CATEGORIES = window.TEMPR_CATEGORIES || [];

  // --- Sample Scripts for Playground ---
  const PLAYGROUND_SAMPLES = {
    worked_example: `# The canonical §11 Worked Example
date 2026-09-27
clock 09:30:00

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
  |> aggregate volume = sum(size),
               turnover = sum(price * size)
  |> derive value = turnover / volume

watch vwap

# 1. Insert Trade 1
clock 10:00:00.100
insert trades {id: 1, event_time: 10:00:00, sym: \`AAPL, price: 200, size: 100}

# 2. Insert Trade 2
clock 10:00:01.100
insert trades {id: 2, event_time: 10:00:01, sym: \`AAPL, price: 202, size: 100}

# 3. Correct Trade 2 (Price 202 -> 204)
clock 10:05:00
correct trades 2 rev 1 {price: 204}

# 4. Retract Trade 1
clock 10:06:00
delete trades 1 rev 1

# 5. Historical Queries
vwap at 10:00:01 known_at 10:01:00
vwap at 10:00:01 known_at 10:05:30
vwap at 10:00:01 known_at 10:06:00
vwap at 10:00:01`,

    tca: `# Recipe 1: Multi-Stage Execution & Transaction Cost Analysis (TCA)
date 2026-09-27
clock 09:30:00

type Execution = {
  id: Int64,
  t: Timestamp,
  sym: Symbol,
  side: Symbol,
  px: Float64,
  qty: Int64,
  fee_bps: Float64,
  ref_px: Float64
}

stream execs: Execution {
  id: id, time: t, window: tumble(1h, origin = UTC_midnight),
  allow_lateness: 5m, correction_grace: 10m, history_after_seal: 1d, future_skew: 1h,
  max_pending: 1000, on_late: reject, on_closed_correction: reject,
  cursor: knowledge, watermark: explicit
}

# 1. Custom per-row math: gross notional, fees, slippage in basis points
view enriched = execs
  |> derive gross_notional = px * qty,
            fee_amount = (px * qty) * (fee_bps / 10000.0),
            slippage_bps = (px - ref_px) / ref_px * 10000.0

# 2. Windowed aggregations: volumes, turnover, custom fee sums, and effective VWAP
view desk_summary = enriched
  |> tumble 1h on t
  |> group window, sym
  |> aggregate total_qty = sum(qty),
               total_notional = sum(gross_notional),
               total_fees = sum(fee_amount),
               avg_slippage = avg(slippage_bps),
               vwap = wavg(qty, px)
  |> derive net_notional = total_notional - total_fees,
            fee_rate_effective = (total_fees / total_notional) * 10000.0

watch desk_summary

clock 09:30:01
insert execs {id: 1, t: 09:30:00, sym: \`AAPL, side: \`BUY, px: 150.50, qty: 200, fee_bps: 2.5, ref_px: 150.00}

clock 09:30:02
insert execs {id: 2, t: 09:30:01, sym: \`AAPL, side: \`BUY, px: 151.00, qty: 300, fee_bps: 2.5, ref_px: 150.50}

desk_summary`,

    imbalance: `# Recipe 2: Order Flow Imbalance via Keyed View Arithmetic (zip)
date 2026-09-27
clock 09:30:00

type Trade = { id: Int64, t: Timestamp, sym: Symbol, side: Symbol, px: Float64, qty: Int64 }
stream trades: Trade {
  id: id, time: t, window: tumble(1h, origin = UTC_midnight),
  allow_lateness: 2m, correction_grace: 10m, history_after_seal: 7d, future_skew: 1h,
  max_pending: 1000, on_late: reject, on_closed_correction: reject,
  cursor: knowledge, watermark: explicit
}

# 1. Buy volume & VWAP
view buys = trades
  |> filter side = \`BUY
  |> tumble 1h on t
  |> group window, sym
  |> aggregate buy_vol = sum(qty), buy_turnover = sum(px * qty)
  |> derive buy_vwap = buy_turnover / buy_vol

# 2. Sell volume & VWAP
view sells = trades
  |> filter side = \`SELL
  |> tumble 1h on t
  |> group window, sym
  |> aggregate sell_vol = sum(qty), sell_turnover = sum(px * qty)
  |> derive sell_vwap = sell_turnover / sell_vol

# 3. Keyed View Arithmetic: Zip buys and sells on (window, sym)
view flow_imbalance = buys
  |> zip sells
  |> derive total_vol = buy_vol + sell_vol,
            net_vol = buy_vol - sell_vol,
            imbalance_pct = ((buy_vol - sell_vol) * 100.0) / (buy_vol + sell_vol),
            spread_vwap = sell_vwap - buy_vwap

watch flow_imbalance

clock 09:30:01
insert trades {id: 1, t: 09:30:00, sym: \`NVDA, side: \`BUY, px: 120.0, qty: 500}

clock 09:30:02
insert trades {id: 2, t: 09:30:01, sym: \`NVDA, side: \`SELL, px: 120.5, qty: 300}

clock 09:30:03
insert trades {id: 3, t: 09:30:02, sym: \`NVDA, side: \`BUY, px: 121.0, qty: 1200}

flow_imbalance`,

    variance: `# Recipe 3: Incremental Sample Variance & Volatility
date 2026-09-27
clock 09:30:00

type PriceTick = { id: Int64, t: Timestamp, sym: Symbol, px: Float64 }
stream ticks: PriceTick {
  id: id, time: t, window: tumble(1h, origin = UTC_midnight),
  allow_lateness: 2m, correction_grace: 10m, history_after_seal: 7d, future_skew: 1h,
  max_pending: 1000, on_late: reject, on_closed_correction: reject,
  cursor: knowledge, watermark: explicit
}

view stats = ticks
  |> tumble 1h on t
  |> group window, sym
  |> aggregate n = count(),
               sum_px = sum(px),
               sum_px2 = sum(px * px)
  |> derive mean = sum_px / n,
            variance = (sum_px2 - (sum_px * sum_px) / n) / (n - 1)

watch stats

clock 09:30:01
insert ticks {id: 1, t: 09:30:00, sym: \`SPY, px: 500.0}

clock 09:30:02
insert ticks {id: 2, t: 09:30:01, sym: \`SPY, px: 504.0}

clock 09:30:03
insert ticks {id: 3, t: 09:30:02, sym: \`SPY, px: 502.0}

stats`,

    microprice: `# Recipe 4: Top-of-Book Micro-Price & Book Pressure Imbalance
date 2026-09-27
clock 09:30:00

type BBO = { id: Int64, t: Timestamp, sym: Symbol, bid: Float64, ask: Float64, bid_sz: Int64, ask_sz: Int64 }
stream quotes: BBO {
  id: id, time: t, window: tumble(1m, origin = UTC_midnight),
  allow_lateness: 0, correction_grace: 1m, history_after_seal: 1d, future_skew: 1h,
  max_pending: 1000, on_late: reject, on_closed_correction: reject,
  cursor: knowledge, watermark: explicit
}

view book_signals = quotes
  |> derive spread = ask - bid,
            mid = (bid + ask) / 2.0,
            spread_bps = (ask - bid) / ((bid + ask) / 2.0) * 10000.0,
            micro_px = (bid * ask_sz + ask * bid_sz) / (bid_sz + ask_sz),
            imbalance = ((bid_sz - ask_sz) * 1.0) / (bid_sz + ask_sz)

view windowed_liquidity = book_signals
  |> tumble 1m on t
  |> group window, sym
  |> aggregate updates = count(),
               avg_spread_bps = avg(spread_bps),
               avg_imbalance = avg(imbalance),
               avg_micro_px = avg(micro_px)

watch windowed_liquidity

clock 09:30:00.100
insert quotes {id: 1, t: 09:30:00.100, sym: \`AAPL, bid: 150.00, ask: 150.05, bid_sz: 1000, ask_sz: 500}

clock 09:30:00.200
insert quotes {id: 2, t: 09:30:00.200, sym: \`AAPL, bid: 150.02, ask: 150.06, bid_sz: 300, ask_sz: 1500}

windowed_liquidity`,


    diamond: `# §6 Diamond View Arithmetic: B = 2A, C = A + B
# Published once per commit without intermediate glitches
date 2026-09-27
clock 10:00:00

type Metric = {id: Int64, t: Timestamp, sym: Symbol, val: Int64}
stream metrics: Metric {
  id: id, time: t, window: tumble(1h, origin = UTC_midnight),
  allow_lateness: 0, correction_grace: 0, history_after_seal: 1d, future_skew: 1h,
  max_pending: 10, on_late: reject, on_closed_correction: reject,
  cursor: knowledge, watermark: explicit
}

view a = metrics |> group sym |> aggregate v = sum(val)
view b = a |> derive w = 2 * v |> select sym, w
view c = a |> zip b |> derive total = v + w

watch c

insert metrics {id: 1, t: 10:00:00, sym: \`AAPL, val: 2}
c`,

    filtering: `# Symbol Filtering & Kleene Three-Valued Logic
date 2026-09-27
clock 09:30:00

type Quote = {id: Int64, t: Timestamp, sym: Symbol, px: Float64, qty: Int64?, venue: Symbol?}
stream quotes: Quote {
  id: id, time: t, window: tumble(1h, origin = UTC_midnight),
  allow_lateness: 0, correction_grace: 10m, history_after_seal: 1d, future_skew: 1h,
  max_pending: 100, on_late: reject, on_closed_correction: reject,
  cursor: knowledge, watermark: explicit
}

view aapl_active = quotes
  |> filter sym = \`AAPL and px > 0
  |> derive notional = px * qty
  |> group sym
  |> aggregate n = count(),
               priced = count(qty),
               total_qty = sum(qty)

begin
insert quotes [
  {id: 1, t: 09:00:00, sym: \`AAPL, px: 10, qty: 5},
  {id: 2, t: 09:00:01, sym: \`MSFT, px: 20, qty: null, venue: \`XNAS},
  {id: 3, t: 09:00:02, sym: \`AAPL, px: 12, qty: null}
]
commit

aapl_active`,

    sealing: `# Window Lifecycle & Sealed Window Rejection
date 2026-09-27
clock 10:00:00

type Trade = {id: Int64, t: Timestamp, sym: Symbol, px: Float64}
stream trades: Trade {
  id: id, time: t, window: tumble(1h, origin = UTC_midnight),
  allow_lateness: 2m, correction_grace: 10m, history_after_seal: 1d, future_skew: 1h,
  max_pending: 10, on_late: reject, on_closed_correction: reject,
  cursor: knowledge, watermark: explicit
}

view live = trades |> tumble 1h on t |> group window, sym |> aggregate n = count()

insert trades {id: 1, t: 10:00:00, sym: \`AAPL, px: 100}

# Advance watermark to 11:10:00 (Window 10:00 closes and seals!)
clock 11:10:00
advance trades watermark 11:10:00

# This correction targets a sealed window and fails closed:
correct trades 1 rev 1 {px: 105}`
  };

  // --- Step-by-Step Data Model for Explorer ---
  const EXPLORER_STEPS = {
    0: {
      title: "Initial State (Pre-ingestion)",
      cursor: "09:00:00",
      watermark: "09:00:00",
      knowledge: "09:00:00",
      windowState: "OPEN",
      windowBadgeClass: "badge-open",
      eventCount: "0 events",
      viewCount: "0 groups",
      trades: [],
      vwapRows: [],
      delta: "(No epoch published)",
      commitSeq: 0
    },
    1: {
      title: "Commit 1: Insert Trade #1",
      cursor: "10:00:00.100",
      watermark: "09:00:00",
      knowledge: "10:00:00.100",
      windowState: "OPEN",
      windowBadgeClass: "badge-open",
      eventCount: "1 event",
      viewCount: "1 group",
      trades: [
        { id: 1, time: "10:00:00", rev: 1, sym: "AAPL", price: 200, size: 100, status: "Active" }
      ],
      vwapRows: [
        { window: "10:00:00", sym: "AAPL", volume: 100, turnover: 20000, value: 200 }
      ],
      delta: "+ window=10:00:00 sym=AAPL volume=100 turnover=20000 value=200",
      commitSeq: 1
    },
    2: {
      title: "Commit 2: Insert Trade #2",
      cursor: "10:00:01.100",
      watermark: "09:00:00",
      knowledge: "10:00:01.100",
      windowState: "OPEN",
      windowBadgeClass: "badge-open",
      eventCount: "2 events",
      viewCount: "1 group",
      trades: [
        { id: 1, time: "10:00:00", rev: 1, sym: "AAPL", price: 200, size: 100, status: "Active" },
        { id: 2, time: "10:00:01", rev: 1, sym: "AAPL", price: 202, size: 100, status: "Active" }
      ],
      vwapRows: [
        { window: "10:00:00", sym: "AAPL", volume: 200, turnover: 40200, value: 201 }
      ],
      delta: "~ window=10:00:00 sym=AAPL volume=100 -> 200 turnover=20000 -> 40200 value=200 -> 201",
      commitSeq: 2
    },
    3: {
      title: "Commit 3: Correct Trade #2 (202 -> 204)",
      cursor: "10:05:00",
      watermark: "09:00:00",
      knowledge: "10:05:00",
      windowState: "OPEN",
      windowBadgeClass: "badge-open",
      eventCount: "2 events (1 corrected)",
      viewCount: "1 group",
      trades: [
        { id: 1, time: "10:00:00", rev: 1, sym: "AAPL", price: 200, size: 100, status: "Active" },
        { id: 2, time: "10:00:01", rev: 2, sym: "AAPL", price: 204, size: 100, status: "Amended" }
      ],
      vwapRows: [
        { window: "10:00:00", sym: "AAPL", volume: 200, turnover: 40400, value: 202 }
      ],
      delta: "~ window=10:00:00 sym=AAPL volume=200 turnover=40200 -> 40400 value=201 -> 202",
      commitSeq: 3
    },
    4: {
      title: "Commit 4: Delete Trade #1 (Retraction)",
      cursor: "10:06:00",
      watermark: "09:00:00",
      knowledge: "10:06:00",
      windowState: "OPEN",
      windowBadgeClass: "badge-open",
      eventCount: "1 live event (1 retracted)",
      viewCount: "1 group",
      trades: [
        { id: 1, time: "10:00:00", rev: 2, sym: "AAPL", price: 200, size: 100, status: "Deleted", retracted: true },
        { id: 2, time: "10:00:01", rev: 2, sym: "AAPL", price: 204, size: 100, status: "Amended" }
      ],
      vwapRows: [
        { window: "10:00:00", sym: "AAPL", volume: 100, turnover: 20400, value: 204 }
      ],
      delta: "~ window=10:00:00 sym=AAPL volume=200 -> 100 turnover=40400 -> 20400 value=202 -> 204",
      commitSeq: 4
    },
    5: {
      title: "Commit 5: Advance Watermark (Window Sealed)",
      cursor: "11:10:00",
      watermark: "11:10:00",
      knowledge: "11:10:00",
      windowState: "SEALED",
      windowBadgeClass: "badge-sealed",
      eventCount: "1 live event (immutable)",
      viewCount: "1 group (sealed)",
      trades: [
        { id: 1, time: "10:00:00", rev: 2, sym: "AAPL", price: 200, size: 100, status: "Deleted", retracted: true },
        { id: 2, time: "10:00:01", rev: 2, sym: "AAPL", price: 204, size: 100, status: "Amended (Sealed)" }
      ],
      vwapRows: [
        { window: "10:00:00", sym: "AAPL", volume: 100, turnover: 20400, value: 204 }
      ],
      delta: "window 2026-09-27T10:00:00 sealed",
      commitSeq: 5
    }
  };

  // --- Math Formatting Engine ---
  function renderMath(expr, displayMode) {
    if (!expr) return '';
    if (window.katex && typeof window.katex.renderToString === 'function') {
      try {
        return window.katex.renderToString(expr.trim(), {
          displayMode: !!displayMode,
          throwOnError: false
        });
      } catch (err) {
        console.warn('KaTeX rendering warning:', err);
      }
    }
    return formatMathFallback(expr.trim(), displayMode);
  }

  function formatMathFallback(expr, displayMode) {
    let clean = escapeHtml(expr);
    clean = clean.replace(/\\text\{([^}]+)\}/g, '<span class="math-text">$1</span>');
    clean = clean.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1 / $2)');
    clean = clean.replace(/\\times/g, '×')
                 .replace(/\\cdot/g, '·')
                 .replace(/\\mu/g, 'μ')
                 .replace(/\\le/g, '≤')
                 .replace(/\\ge/g, '≥')
                 .replace(/\\sum/g, '∑')
                 .replace(/\\max/g, 'max')
                 .replace(/\\dots/g, '…');
    clean = clean.replace(/\^2/g, '²').replace(/\^(\d+)/g, '<sup>$1</sup>');
    clean = clean.replace(/_\{([^}]+)\}/g, '<sub>$1</sub>').replace(/_([a-zA-Z0-9]+)/g, '<sub>$1</sub>');

    if (displayMode) {
      return `<div class="katex-display-fallback"><span class="math-fallback">${clean}</span></div>`;
    }
    return `<span class="math-fallback">${clean}</span>`;
  }

  // --- Lightweight Markdown Parser ---
  function parseMarkdown(md) {
    if (!md) return '';

    let html = '';
    const lines = md.split('\n');
    let inCode = false;
    let codeLang = '';
    let codeIndent = 0;
    let codeContent = [];
    let codeInList = false;

    let inMath = false;
    let mathContent = [];

    let inTable = false;
    let tableRows = [];

    let inList = false;
    let listType = 'ul';
    let inListItem = false;

    function closeListItem() {
      if (inListItem) {
        html += '</li>\n';
        inListItem = false;
      }
    }

    function flushList() {
      closeListItem();
      if (inList) {
        html += `</${listType}>\n`;
        inList = false;
      }
    }

    function flushTable() {
      if (inTable && tableRows.length > 0) {
        html += '<table>\n';
        const headers = tableRows[0];
        html += '<thead><tr>\n';
        headers.forEach(h => html += `<th>${inlineFormat(h.trim())}</th>\n`);
        html += '</tr></thead>\n<tbody>\n';
        for (let i = 2; i < tableRows.length; i++) {
          html += '<tr>\n';
          tableRows[i].forEach(cell => html += `<td>${inlineFormat(cell.trim())}</td>\n`);
          html += '</tr>\n';
        }
        html += '</tbody></table>\n';
        inTable = false;
        tableRows = [];
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 1. Code blocks (can be top-level or indented inside lists)
      const codeFenceMatch = line.match(/^(\s*)```([a-zA-Z0-9_-]*)/);
      if (codeFenceMatch && !inCode) {
        inCode = true;
        codeIndent = codeFenceMatch[1].length;
        codeLang = codeFenceMatch[2].trim();
        codeContent = [];
        codeInList = inList && inListItem;
        continue;
      } else if (inCode && line.trim().startsWith('```')) {
        inCode = false;
        const cleanedLines = codeContent.map(cl => {
          let s = 0;
          while (s < codeIndent && cl.startsWith(' ')) {
            cl = cl.slice(1);
            s++;
          }
          return cl;
        });
        const rawCode = cleanedLines.join('\n');
        const highlighted = syntaxHighlight(rawCode, codeLang);
        const langLabel = codeLang || 'text';
        const blockHtml = `<div class="code-block-wrapper">
          <div class="code-header">
            <span>${escapeHtml(langLabel.toUpperCase())}</span>
            <button class="copy-btn" data-code="${escapeHtml(rawCode)}">Copy</button>
          </div>
          <pre class="code-content"><code>${highlighted}</code></pre>
        </div>\n`;

        if (codeInList && inList && inListItem) {
          html += blockHtml;
        } else {
          flushList();
          flushTable();
          html += blockHtml;
        }
        codeContent = [];
        continue;
      }

      if (inCode) {
        codeContent.push(line);
        continue;
      }

      // 2. Display Math ($$)
      if (line.trim().startsWith('$$')) {
        flushList();
        flushTable();
        if (inMath) {
          const mathExpr = mathContent.join('\n');
          html += `<div class="katex-display-wrapper">${renderMath(mathExpr, true)}</div>\n`;
          inMath = false;
          mathContent = [];
          continue;
        } else if (line.trim().endsWith('$$') && line.trim().length > 2) {
          const mathExpr = line.trim().slice(2, -2).trim();
          html += `<div class="katex-display-wrapper">${renderMath(mathExpr, true)}</div>\n`;
          continue;
        } else {
          inMath = true;
          mathContent = [];
          continue;
        }
      }

      if (inMath) {
        mathContent.push(line);
        continue;
      }

      // 3. Tables
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        flushList();
        inTable = true;
        const cols = line.trim().slice(1, -1).split('|');
        tableRows.push(cols);
        continue;
      } else if (inTable) {
        flushTable();
      }

      // 4. Lists (ul and ol)
      const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
      const olMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
      if (ulMatch) {
        if (!inList || listType !== 'ul') {
          flushList();
          html += '<ul>\n';
          inList = true;
          listType = 'ul';
        } else {
          closeListItem();
        }
        html += `<li>${inlineFormat(ulMatch[2])}`;
        inListItem = true;
        continue;
      } else if (olMatch) {
        if (!inList || listType !== 'ol') {
          flushList();
          html += '<ol>\n';
          inList = true;
          listType = 'ol';
        } else {
          closeListItem();
        }
        html += `<li>${inlineFormat(olMatch[2])}`;
        inListItem = true;
        continue;
      }

      // Indented continuation inside list item
      if (inList && inListItem && (line.startsWith('  ') || line.startsWith('\t'))) {
        html += `<p>${inlineFormat(line.trim())}</p>\n`;
        continue;
      }

      // Blank lines
      if (line.trim() === '') {
        let listContinues = false;
        for (let j = i + 1; j < lines.length; j++) {
          const nl = lines[j];
          if (nl.trim() === '') continue;
          if (nl.match(/^(\s*)[-*+]\s+/) || nl.match(/^(\s*)\d+\.\s+/) || nl.match(/^(\s*)```/)) {
            listContinues = true;
          }
          break;
        }
        if (!listContinues) {
          flushList();
        }
        continue;
      }

      // 5. Headings
      if (line.startsWith('# ')) {
        flushList();
        html += `<h1 id="${slugify(line.slice(2))}">${inlineFormat(line.slice(2))}</h1>\n`;
        continue;
      }
      if (line.startsWith('## ')) {
        flushList();
        html += `<h2 id="${slugify(line.slice(3))}">${inlineFormat(line.slice(3))}</h2>\n`;
        continue;
      }
      if (line.startsWith('### ')) {
        flushList();
        html += `<h3 id="${slugify(line.slice(4))}">${inlineFormat(line.slice(4))}</h3>\n`;
        continue;
      }
      if (line.startsWith('#### ')) {
        flushList();
        html += `<h4 id="${slugify(line.slice(5))}">${inlineFormat(line.slice(5))}</h4>\n`;
        continue;
      }

      // 6. Callouts / Blockquotes
      if (line.startsWith('> [!NOTE]')) {
        flushList();
        html += '<div class="callout callout-note"><div class="callout-title">Note</div><p>';
        continue;
      }
      if (line.startsWith('> [!TIP]')) {
        flushList();
        html += '<div class="callout callout-tip"><div class="callout-title">Tip</div><p>';
        continue;
      }
      if (line.startsWith('> [!IMPORTANT]')) {
        flushList();
        html += '<div class="callout callout-important"><div class="callout-title">Important</div><p>';
        continue;
      }
      if (line.startsWith('> [!WARNING]')) {
        flushList();
        html += '<div class="callout callout-warning"><div class="callout-title">Warning</div><p>';
        continue;
      }
      if (line.startsWith('> ')) {
        html += `${inlineFormat(line.slice(2))}</p></div>\n`;
        continue;
      }

      // 7. Horizontal Rule
      if (line.trim() === '---' || line.trim() === '***') {
        flushList();
        html += '<hr>\n';
        continue;
      }

      if (/^<div\b/.test(line.trim())) {
        flushList();
        html += line + '\n';
        continue;
      }

      // 8. Normal Paragraph
      flushList();
      html += `<p>${inlineFormat(line)}</p>\n`;
    }

    flushList();
    flushTable();
    return html;
  }

  // --- Inline Formatter ---
  function inlineFormat(text) {
    if (!text) return '';

    // 1. Stash inline code `...`
    const codeBlocks = [];
    let processed = text.replace(/`([^`]+)`/g, (match, p1) => {
      codeBlocks.push(p1);
      return `%%%TEMPRCODE${codeBlocks.length - 1}%%%`;
    });

    // 2. Render inline math $...$
    processed = processed.replace(/(^|[^\\])\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g, (match, prefix, mathExpr) => {
      return prefix + renderMath(mathExpr, false);
    });

    // Handle escaped \$
    processed = processed.replace(/\\\$/g, '$');

    // 3. Bold + Italic
    processed = processed
      .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/___(.*?)___/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.*?)__/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/_([^_ \n]+)_/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // 4. Restore inline code
    processed = processed.replace(/%%%TEMPRCODE(\d+)%%%/g, (match, idx) => {
      return `<code>${escapeHtml(codeBlocks[Number(idx)])}</code>`;
    });

    return processed;
  }

  function slugify(text) {
    return text.toLowerCase()
      .replace(/[^\w\s-§]/g, '')
      .trim()
      .replace(/\s+/g, '-');
  }

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- Syntax Highlighter for tempr DSL, C, Bash, and Output Streams ---
  function syntaxHighlight(code, lang) {
    const token = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'[^'\n]*'|\b(?:typedef|struct|enum|void|const|bool|true|false|int|int64_t|uint64_t|uint32_t|double|size_t|return|if|else|for|while|static|NULL|type|stream|view|insert|correct|delete|aggregate|group|tumble|known_at)\b|\btr_[A-Za-z0-9_]+\b)/g;
    // Only tokenize known languages. Escape every raw token before adding markup.
    if (!['c', 'cpp', 'tempr', 'sql'].includes(lang)) return escapeHtml(code);
    return code.split(token).map((part, i) => {
      if (i % 2 === 0) return escapeHtml(part);
      const color = part.startsWith('/') ? 'var(--text-muted)' : part.startsWith('tr_') ? 'var(--accent-cyan)' : 'var(--accent-indigo)';
      return `<span style="color: ${color}">${escapeHtml(part)}</span>`;
    }).join('');
  }

  // --- Document Loading & Rendering ---
  function renderDocument(docId) {
    const docs = window.TEMPR_DOCS || [];
    const doc = docs.find(d => d.id === docId) || docs[0];
    if (!doc) return;

    currentDocId = doc.id;

    // Render breadcrumb
    const breadcrumb = document.getElementById('breadcrumb');
    let categoryTitle = 'Documentation';
    for (const cat of CATEGORIES) {
      if (cat.docIds.includes(doc.id)) {
        categoryTitle = cat.title;
        break;
      }
    }
    breadcrumb.innerHTML = `<span>Docs</span> <span class="breadcrumb-sep">/</span> <span>${categoryTitle}</span> <span class="breadcrumb-sep">/</span> <span style="color: var(--text-primary);">${doc.title}</span>`;

    // Render markdown article
    const article = document.getElementById('docArticle');
    article.innerHTML = parseMarkdown(doc.content);
    article.classList.toggle('api-ref', Boolean(doc.symbols));
    document.title = `${doc.title} · tempr reference`;
    if (doc.symbols) {
      const list = document.createElement('div');
      list.className = 'symbol-list';
      for (const symbol of doc.symbols) {
        const link = document.createElement('a');
        link.href = `#doc/${doc.id}#${symbol}`;
        link.textContent = symbol;
        list.appendChild(link);
      }
      article.querySelector('h1').after(list);
    }

    // Update active state in sidebar
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.toggle('active', link.dataset.id === doc.id);
    });

    // Update pagination links
    const currentIndex = docs.findIndex(d => d.id === doc.id);
    const prevLink = document.getElementById('pagePrev');
    const nextLink = document.getElementById('pageNext');

    if (currentIndex > 0) {
      prevLink.style.visibility = 'visible';
      prevLink.href = `#doc/${docs[currentIndex - 1].id}`;
      document.getElementById('pagePrevTitle').textContent = docs[currentIndex - 1].title;
    } else {
      prevLink.style.visibility = 'hidden';
    }

    if (currentIndex < docs.length - 1) {
      nextLink.style.visibility = 'visible';
      nextLink.href = `#doc/${docs[currentIndex + 1].id}`;
      document.getElementById('pageNextTitle').textContent = docs[currentIndex + 1].title;
    } else {
      nextLink.style.visibility = 'hidden';
    }

    // Generate Table of Contents
    generateTableOfContents();

    // Attach copy buttons
    attachCopyButtons();

    // Scroll to top of content
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  // --- Table of Contents Generator ---
  function generateTableOfContents() {
    const tocNav = document.getElementById('tocNav');
    tocNav.innerHTML = '';

    const headings = document.querySelectorAll('#docArticle h2, #docArticle h3');
    headings.forEach(h => {
      const link = document.createElement('a');
      link.className = 'toc-link';
      link.href = `#doc/${currentDocId}#${h.id}`;
      link.textContent = h.textContent;
      if (h.tagName.toLowerCase() === 'h3') {
        link.style.paddingLeft = '18px';
        link.style.fontSize = '12px';
      }
      link.addEventListener('click', (e) => {
        e.preventDefault();
        h.scrollIntoView({ behavior: 'smooth' });
        history.pushState(null, '', `#doc/${currentDocId}#${h.id}`);
      });
      tocNav.appendChild(link);
    });

    // Highlight TOC on scroll
    setupScrollSpy();
  }

  let stopScrollSpy;
  function setupScrollSpy() {
    if (stopScrollSpy) stopScrollSpy();
    const headings = Array.from(document.querySelectorAll('#docArticle h2, #docArticle h3'));
    const tocLinks = Array.from(document.querySelectorAll('.toc-link'));
    if (!headings.length) return;

    const onScroll = () => {
      let current = '';
      const scrollPos = window.scrollY + 100;

      for (let i = headings.length - 1; i >= 0; i--) {
        if (headings[i].offsetTop <= scrollPos) {
          current = headings[i].id;
          break;
        }
      }

      tocLinks.forEach(link => {
        link.classList.toggle('active', link.getAttribute('href') === `#doc/${currentDocId}#${current}`);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    stopScrollSpy = () => window.removeEventListener('scroll', onScroll);
  }

  // --- Copy Code Blocks ---
  function attachCopyButtons() {
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.getAttribute('data-code');
        navigator.clipboard.writeText(code).then(() => {
          const original = btn.textContent;
          btn.textContent = 'Copied!';
          btn.style.color = 'var(--accent-emerald)';
          showToast('Code copied to clipboard');
          setTimeout(() => {
            btn.textContent = original;
            btn.style.color = '';
          }, 1800);
        });
      });
    });
  }

  // --- Sidebar Generator ---
  function populateSidebar() {
    const sidebarNav = document.getElementById('sidebarNav');
    sidebarNav.innerHTML = '';
    const docs = window.TEMPR_DOCS || [];

    CATEGORIES.forEach(cat => {
      const groupDiv = document.createElement('div');
      groupDiv.className = 'nav-group';

      const titleDiv = document.createElement('div');
      titleDiv.className = 'group-title';
      titleDiv.textContent = cat.title;
      groupDiv.appendChild(titleDiv);

      cat.docIds.forEach(id => {
        const doc = docs.find(d => d.id === id);
        if (!doc) return;

        const link = document.createElement('a');
        link.className = 'nav-link';
        link.dataset.id = doc.id;
        link.href = `#doc/${doc.id}`;
        link.innerHTML = `<span>${doc.title}</span>`;
        link.addEventListener('click', (e) => {
          e.preventDefault();
          switchView('docs');
          renderDocument(doc.id);
          history.pushState(null, '', `#doc/${doc.id}`);
          // Close mobile menu if open
          document.getElementById('sidebar').classList.remove('open');
          document.getElementById('mobileMenuBtn').setAttribute('aria-expanded', 'false');
        });
        groupDiv.appendChild(link);
      });

      sidebarNav.appendChild(groupDiv);
    });
  }

  // --- View Switcher ---
  function switchView(viewName) {
    document.querySelectorAll('.view-container').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));

    if (viewName === 'docs') {
      document.getElementById('viewDocs').classList.add('active');
      document.getElementById('tabDocs').classList.add('active');
    } else if (viewName === 'explorer') {
      document.getElementById('viewExplorer').classList.add('active');
      document.getElementById('tabExplorer').classList.add('active');
      updateExplorerStep(currentExplorerStep);
    } else if (viewName === 'playground') {
      document.getElementById('viewPlayground').classList.add('active');
      loadPlaygroundSample('worked_example');
    }
  }

  // --- Time-Travel Explorer Logic ---
  function updateExplorerStep(step) {
    currentExplorerStep = step;
    const data = EXPLORER_STEPS[step];
    if (!data) return;

    // Update stepper cards active class
    document.querySelectorAll('.step-card').forEach(card => {
      card.classList.toggle('active', parseInt(card.dataset.step) === step);
    });

    // Update Coordinates
    document.getElementById('valCursor').textContent = data.cursor;
    document.getElementById('valWatermark').textContent = data.watermark;
    document.getElementById('valKnowledge').textContent = data.knowledge;
    
    const badgeWindow = document.getElementById('badgeWindowState');
    badgeWindow.textContent = data.windowState;
    badgeWindow.className = `status-badge ${data.windowBadgeClass}`;

    // Update Event Table
    document.getElementById('tagEventCount').textContent = data.eventCount;
    const tbodyTrades = document.querySelector('#tableTrades tbody');
    tbodyTrades.innerHTML = '';
    if (data.trades.length === 0) {
      tbodyTrades.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No events committed yet</td></tr>`;
    } else {
      data.trades.forEach(t => {
        const tr = document.createElement('tr');
        if (t.retracted) tr.className = 'row-retracted';
        tr.innerHTML = `
          <td><strong>${t.id}</strong></td>
          <td>${t.time}</td>
          <td>${t.rev}</td>
          <td><span style="color: var(--accent-emerald); font-weight: 600;">\`${t.sym}</span></td>
          <td>${t.price.toFixed(2)}</td>
          <td>${t.size}</td>
          <td><span class="status-badge ${t.retracted ? 'badge-sealed' : 'badge-open'}">${t.status}</span></td>
        `;
        tbodyTrades.appendChild(tr);
      });
    }

    // Update VWAP Materialization Table
    document.getElementById('tagViewCount').textContent = data.viewCount;
    const tbodyVwap = document.querySelector('#tableVwap tbody');
    tbodyVwap.innerHTML = '';
    if (data.vwapRows.length === 0) {
      tbodyVwap.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">(Empty view)</td></tr>`;
    } else {
      data.vwapRows.forEach(v => {
        const tr = document.createElement('tr');
        tr.className = 'row-active';
        tr.innerHTML = `
          <td>${v.window}</td>
          <td><span style="color: var(--accent-emerald); font-weight: 600;">\`${v.sym}</span></td>
          <td>${v.volume}</td>
          <td>${v.turnover.toLocaleString()}</td>
          <td><strong style="color: var(--accent-cyan);">${v.value.toFixed(2)}</strong></td>
        `;
        tbodyVwap.appendChild(tr);
      });
    }

    // Update Delta Box
    document.getElementById('deltaCode').textContent = data.delta;
  }

  function runTimeTravelQuery() {
    const atTime = document.getElementById('queryAtTime').value;
    const knownAt = document.getElementById('queryKnownAt').value;
    const statusEl = document.getElementById('queryStatus');
    const contentEl = document.getElementById('queryResultContent');

    // Rule 1: known_at before commit 1 (09:00:00)
    if (knownAt === '09:00:00') {
      statusEl.textContent = 'TR_E_BEYOND_CURSOR';
      statusEl.className = 'result-status status-error';
      contentEl.innerHTML = `<div style="color: var(--accent-rose); font-family: var(--font-mono); font-size: 13px;">
        error: BEYOND_CURSOR: trades: at is beyond the event cursor (cursor 09:00:00)
      </div>`;
      return;
    }

    // Rule 2: Future window query
    if (atTime === '11:30:00') {
      statusEl.textContent = 'TR_E_BEYOND_CURSOR';
      statusEl.className = 'result-status status-error';
      contentEl.innerHTML = `<div style="color: var(--accent-rose); font-family: var(--font-mono); font-size: 13px;">
        error: BEYOND_CURSOR: query timestamp 11:30:00 is ahead of cursor at selected snapshot.
      </div>`;
      return;
    }

    // Normal historical query results
    statusEl.className = 'result-status status-ok';

    if (knownAt === '10:01:00') {
      // Commit 2 snapshot
      if (atTime === '10:00:00' || atTime === '10:00:00.500') {
        statusEl.textContent = 'OK (Commit @1 snapshot)';
        contentEl.innerHTML = `<table class="data-table">
          <thead><tr><th>window</th><th>sym</th><th>volume</th><th>turnover</th><th>value (VWAP)</th></tr></thead>
          <tbody><tr><td>2026-09-27T10:00:00</td><td>AAPL</td><td>100</td><td>20000</td><td><strong style="color: var(--accent-cyan);">200.00</strong></td></tr></tbody>
        </table>`;
      } else {
        statusEl.textContent = 'OK (Commit @2 snapshot: Both original trades)';
        contentEl.innerHTML = `<table class="data-table">
          <thead><tr><th>window</th><th>sym</th><th>volume</th><th>turnover</th><th>value (VWAP)</th></tr></thead>
          <tbody><tr><td>2026-09-27T10:00:00</td><td>AAPL</td><td>200</td><td>40200</td><td><strong style="color: var(--accent-cyan);">201.00</strong></td></tr></tbody>
        </table>`;
      }
    } else if (knownAt === '10:05:30') {
      // Commit 3 snapshot: after price correction to 204
      if (atTime === '10:00:00' || atTime === '10:00:00.500') {
        statusEl.textContent = 'OK (Prefix excludes 10:00:01 trade)';
        contentEl.innerHTML = `<table class="data-table">
          <thead><tr><th>window</th><th>sym</th><th>volume</th><th>turnover</th><th>value (VWAP)</th></tr></thead>
          <tbody><tr><td>2026-09-27T10:00:00</td><td>AAPL</td><td>100</td><td>20000</td><td><strong style="color: var(--accent-cyan);">200.00</strong></td></tr></tbody>
        </table>`;
      } else {
        statusEl.textContent = 'OK (Commit @3 snapshot: Trade 2 price @ 204)';
        contentEl.innerHTML = `<table class="data-table">
          <thead><tr><th>window</th><th>sym</th><th>volume</th><th>turnover</th><th>value (VWAP)</th></tr></thead>
          <tbody><tr><td>2026-09-27T10:00:00</td><td>AAPL</td><td>200</td><td>40400</td><td><strong style="color: var(--accent-cyan);">202.00</strong></td></tr></tbody>
        </table>`;
      }
    } else {
      // Commit 4 / Latest snapshot: Trade 1 retracted
      statusEl.textContent = 'OK (Commit @4: Trade 1 retracted, Trade 2 @ 204)';
      contentEl.innerHTML = `<table class="data-table">
        <thead><tr><th>window</th><th>sym</th><th>volume</th><th>turnover</th><th>value (VWAP)</th></tr></thead>
        <tbody><tr><td>2026-09-27T10:00:00</td><td>AAPL</td><td>100</td><td>20400</td><td><strong style="color: var(--accent-cyan);">204.00</strong></td></tr></tbody>
      </table>`;
    }
  }

  // --- Playground Simulator ---
  function loadPlaygroundSample(key) {
    const code = PLAYGROUND_SAMPLES[key] || PLAYGROUND_SAMPLES.worked_example;
    document.getElementById('playgroundCode').value = code;
  }

  function runPlaygroundScript() {
    const code = document.getElementById('playgroundCode').value;
    const outputEl = document.getElementById('playgroundOutput');

    // Simulate script evaluation
    outputEl.innerHTML = `<span class="term-comment"># Showing illustrative output for a bundled sample; no native code is executed.</span>\n`;

    setTimeout(() => {
      let result = '';
      if (code.includes('stream trades') && code.includes('view vwap')) {
        result = `<span class="term-comment">type Trade</span>
<span class="term-comment">stream trades</span>
<span class="term-comment">view vwap</span>
<span class="term-comment">watching vwap from commit 0</span>
<span class="term-commit">@1 known 2026-09-27T10:00:00.100</span>
<span class="term-commit">vwap @1 known 2026-09-27T10:00:00.100</span>
<span class="term-plus">  + window=2026-09-27T10:00:00 sym=AAPL volume=100 turnover=20000 value=200</span>
<span class="term-commit">@2 known 2026-09-27T10:00:01.100</span>
<span class="term-commit">vwap @2 known 2026-09-27T10:00:01.100</span>
<span class="term-tilde">  ~ window=2026-09-27T10:00:00 sym=AAPL volume=100 -> 200 turnover=20000 -> 40200 value=200 -> 201</span>
<span class="term-commit">@3 known 2026-09-27T10:05:00</span>
<span class="term-commit">vwap @3 known 2026-09-27T10:05:00</span>
<span class="term-tilde">  ~ window=2026-09-27T10:00:00 sym=AAPL volume=200 turnover=40200 -> 40400 value=201 -> 202</span>
<span class="term-commit">@4 known 2026-09-27T10:06:00</span>
<span class="term-commit">vwap @4 known 2026-09-27T10:06:00</span>
<span class="term-tilde">  ~ window=2026-09-27T10:00:00 sym=AAPL volume=200 -> 100 turnover=40400 -> 20400 value=202 -> 204</span>

<span class="term-header">window              sym  volume turnover value</span>
<span class="term-comment">------------------- ---- ------ -------- -----</span>
2026-09-27T10:00:00 AAPL    200    40200   201
<span class="term-comment">(1 row @2)</span>

<span class="term-header">window              sym  volume turnover value</span>
<span class="term-comment">------------------- ---- ------ -------- -----</span>
2026-09-27T10:00:00 AAPL    200    40400   202
<span class="term-comment">(1 row @3)</span>

<span class="term-header">window              sym  volume turnover value</span>
<span class="term-comment">------------------- ---- ------ -------- -----</span>
2026-09-27T10:00:00 AAPL    100    20400   204
<span class="term-comment">(1 row @4)</span>

<span class="term-header">window              sym  volume turnover value</span>
<span class="term-comment">------------------- ---- ------ -------- -----</span>
2026-09-27T10:00:00 AAPL    100    20400   204
<span class="term-comment">(1 row @4)</span>`;
      } else if (code.includes('desk_summary')) {
        result = `<span class="term-comment">type Execution</span>
<span class="term-comment">stream execs</span>
<span class="term-comment">view enriched</span>
<span class="term-comment">view desk_summary</span>
<span class="term-comment">watching desk_summary from commit 0</span>
<span class="term-commit">@1 known 2026-09-27T09:30:01</span>
<span class="term-commit">desk_summary @1 known 2026-09-27T09:30:01</span>
<span class="term-plus">  + window=2026-09-27T09:00:00 sym=AAPL total_qty=200 total_notional=30100 total_fees=7.525 avg_slippage=33.33 vwap=150.5 net_notional=30092.48 fee_rate_effective=2.5</span>
<span class="term-commit">@2 known 2026-09-27T09:30:02</span>
<span class="term-commit">desk_summary @2 known 2026-09-27T09:30:02</span>
<span class="term-tilde">  ~ window=2026-09-27T09:00:00 sym=AAPL total_qty=200 -> 500 total_notional=30100 -> 75400 total_fees=7.525 -> 18.85 avg_slippage=33.33 -> 33.28 vwap=150.5 -> 150.8 net_notional=30092.48 -> 75381.15 fee_rate_effective=2.5</span>

<span class="term-header">window              sym  total_qty total_notional total_fees avg_slippage vwap  net_notional fee_rate_effective</span>
<span class="term-comment">------------------- ---- --------- -------------- ---------- ------------ ----- ------------ ------------------</span>
2026-09-27T09:00:00 AAPL       500          75400      18.85        33.28 150.8     75381.15                2.5
<span class="term-comment">(1 row @2)</span>`;
      } else if (code.includes('flow_imbalance')) {
        result = `<span class="term-comment">type Trade</span>
<span class="term-comment">stream trades</span>
<span class="term-comment">view buys</span>
<span class="term-comment">view sells</span>
<span class="term-comment">view flow_imbalance</span>
<span class="term-comment">watching flow_imbalance from commit 0</span>
<span class="term-commit">@1 known 2026-09-27T09:30:01</span>
<span class="term-commit">@2 known 2026-09-27T09:30:02</span>
<span class="term-commit">flow_imbalance @2 known 2026-09-27T09:30:02</span>
<span class="term-plus">  + window=2026-09-27T09:00:00 sym=NVDA buy_vol=500 buy_turnover=60000 buy_vwap=120 sell_vol=300 sell_turnover=36150 sell_vwap=120.5 total_vol=800 net_vol=200 imbalance_pct=25 spread_vwap=0.5</span>
<span class="term-commit">@3 known 2026-09-27T09:30:03</span>
<span class="term-commit">flow_imbalance @3 known 2026-09-27T09:30:03</span>
<span class="term-tilde">  ~ window=2026-09-27T09:00:00 sym=NVDA buy_vol=500 -> 1700 buy_turnover=60000 -> 205200 buy_vwap=120 -> 120.71 total_vol=800 -> 2000 net_vol=200 -> 1400 imbalance_pct=25 -> 70 spread_vwap=0.5 -> -0.21</span>

<span class="term-header">window              sym  buy_vol buy_turnover buy_vwap sell_vol sell_turnover sell_vwap total_vol net_vol imbalance_pct spread_vwap</span>
<span class="term-comment">------------------- ---- ------- ------------ -------- -------- ------------- --------- --------- ------- ------------- -----------</span>
2026-09-27T09:00:00 NVDA    1700       205200   120.71      300         36150    120.50      2000    1400            70       -0.21
<span class="term-comment">(1 row @3)</span>`;
      } else if (code.includes('variance =')) {
        result = `<span class="term-comment">type PriceTick</span>
<span class="term-comment">stream ticks</span>
<span class="term-comment">view stats</span>
<span class="term-comment">watching stats from commit 0</span>
<span class="term-commit">@1 known 2026-09-27T09:30:01</span>
<span class="term-commit">stats @1 known 2026-09-27T09:30:01</span>
<span class="term-plus">  + window=2026-09-27T09:00:00 sym=SPY n=1 sum_px=500 sum_px2=250000 mean=500 variance=null</span>
<span class="term-comment"># Note: (n-1)=0 safely yields null (no crash!)</span>
<span class="term-commit">@2 known 2026-09-27T09:30:02</span>
<span class="term-commit">stats @2 known 2026-09-27T09:30:02</span>
<span class="term-tilde">  ~ window=2026-09-27T09:00:00 sym=SPY n=1 -> 2 sum_px=500 -> 1004 sum_px2=250000 -> 504016 mean=500 -> 502 variance=null -> 8</span>
<span class="term-commit">@3 known 2026-09-27T09:30:03</span>
<span class="term-commit">stats @3 known 2026-09-27T09:30:03</span>
<span class="term-tilde">  ~ window=2026-09-27T09:00:00 sym=SPY n=2 -> 3 sum_px=1004 -> 1506 sum_px2=504016 -> 756020 mean=502 variance=8 -> 4</span>

<span class="term-header">window              sym n sum_px sum_px2 mean variance</span>
<span class="term-comment">------------------- --- - ------ ------- ---- --------</span>
2026-09-27T09:00:00 SPY 3   1506  756020  502        4
<span class="term-comment">(1 row @3)</span>`;
      } else if (code.includes('book_signals')) {
        result = `<span class="term-comment">type BBO</span>
<span class="term-comment">stream quotes</span>
<span class="term-comment">view book_signals</span>
<span class="term-comment">view windowed_liquidity</span>
<span class="term-comment">watching windowed_liquidity from commit 0</span>
<span class="term-commit">@1 known 2026-09-27T09:30:00.100</span>
<span class="term-commit">windowed_liquidity @1 known 2026-09-27T09:30:00.100</span>
<span class="term-plus">  + window=2026-09-27T09:30:00 sym=AAPL updates=1 avg_spread_bps=3.33 avg_imbalance=0.33 avg_micro_px=150.03</span>
<span class="term-commit">@2 known 2026-09-27T09:30:00.200</span>
<span class="term-commit">windowed_liquidity @2 known 2026-09-27T09:30:00.200</span>
<span class="term-tilde">  ~ window=2026-09-27T09:30:00 sym=AAPL updates=1 -> 2 avg_spread_bps=3.33 -> 3.00 avg_imbalance=0.33 -> -0.17 avg_micro_px=150.03 -> 150.03</span>

<span class="term-header">window              sym  updates avg_spread_bps avg_imbalance avg_micro_px</span>
<span class="term-comment">------------------- ---- ------- -------------- ------------- ------------</span>
2026-09-27T09:30:00 AAPL       2           3.00         -0.17       150.03
<span class="term-comment">(1 row @2)</span>`;
      } else if (code.includes('zip b')) {

        result = `<span class="term-comment">type Metric</span>
<span class="term-comment">stream metrics</span>
<span class="term-comment">view a</span>
<span class="term-comment">view b</span>
<span class="term-comment">view c</span>
<span class="term-comment">watching c from commit 0</span>
<span class="term-commit">@1 known 2026-09-27T10:00:00</span>
<span class="term-commit">c @1 known 2026-09-27T10:00:00</span>
<span class="term-plus">  + sym=AAPL v=2 w=4 total=6</span>
<span class="term-header">sym  v w total</span>
<span class="term-comment">---- - - -----</span>
AAPL 2 4     6
<span class="term-comment">(1 row @1)</span>
<span class="term-comment"># Published exactly once: no torn intermediate 4!</span>`;
      } else if (code.includes('SEALED') || code.includes('advance trades watermark 11:10:00')) {
        result = `<span class="term-comment">type Trade</span>
<span class="term-comment">stream trades</span>
<span class="term-comment">view live</span>
<span class="term-commit">@1 known 2026-09-27T10:00:00</span>
<span class="term-commit">@2 known 2026-09-27T11:10:00</span>
<span class="term-comment">  window 2026-09-27T10:00:00 sealed</span>
<span class="term-error">error: WINDOW_SEALED: trades: window is sealed (window 2026-09-27T10:00:00)</span>
<span class="term-comment"># Mutation was safely rejected before modifying in-memory state.</span>`;
      } else {
        result = `<span class="term-comment"># Script parsed successfully.</span>
<span class="term-commit">@1 known 2026-09-27T09:30:00</span>
<span class="term-header">sym  n priced total_qty</span>
<span class="term-comment">---- - ------ ---------</span>
AAPL 2      1         5
<span class="term-comment">(1 row @1)</span>`;
      }

      outputEl.innerHTML = result;
      showToast('Script executed successfully');
    }, 120);
  }

  // --- Search Indexer & Modal ---
  function buildSearchIndex() {
    const docs = window.TEMPR_DOCS || [];
    searchIndex = [];

    docs.forEach(doc => {
      for (const symbol of (doc.symbols || [])) {
        searchIndex.push({docId: doc.id, headingId: symbol, title: symbol, snippet: doc.title});
      }
      // Document title entry
      searchIndex.push({
        docId: doc.id,
        headingId: '',
        title: doc.title,
        snippet: doc.content.slice(0, 140).replace(/#/g, '').trim()
      });

      // Section headings
      const lines = doc.content.split('\n');
      let currentSection = doc.title;
      let currentSectionId = '';

      lines.forEach(l => {
        if (l.startsWith('## ')) {
          currentSection = l.slice(3).trim();
          currentSectionId = slugify(currentSection);
          searchIndex.push({
            docId: doc.id,
            headingId: currentSectionId,
            title: `${doc.title} → ${currentSection}`,
            snippet: currentSection
          });
        }
      });
    });
  }

  function handleSearch(query) {
    const resultsEl = document.getElementById('searchResults');
    resultsEl.innerHTML = '';
    query = (query || '').toLowerCase().trim();

    if (!query) {
      resultsEl.innerHTML = '<div class="search-empty">Type keywords to search documentation...</div>';
      return;
    }

    const matches = searchIndex.filter(item =>
      item.title.toLowerCase().includes(query) || item.snippet.toLowerCase().includes(query)
    ).slice(0, 8);

    if (matches.length === 0) {
      resultsEl.innerHTML = `<div class="search-empty">No results found for "<strong>${escapeHtml(query)}</strong>"</div>`;
      return;
    }

    matches.forEach(item => {
      const a = document.createElement('a');
      a.className = 'search-item';
      a.href = `#doc/${item.docId}${item.headingId ? '#' + item.headingId : ''}`;
      a.innerHTML = `
        <span class="search-item-title">${escapeHtml(item.title)}</span>
        <span class="search-item-snippet">${escapeHtml(item.snippet)}</span>
      `;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        closeSearch();
        switchView('docs');
        renderDocument(item.docId);
        history.pushState(null, '', a.href);
        if (item.headingId) {
          const el = document.getElementById(item.headingId);
          if (el) el.scrollIntoView({ behavior: 'instant' });
        }
      });
      resultsEl.appendChild(a);
    });
  }

  function openSearch() {
    const modal = document.getElementById('searchModal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    const input = document.getElementById('modalSearchInput');
    input.value = '';
    input.focus();
    handleSearch('');
  }

  function closeSearch() {
    const modal = document.getElementById('searchModal');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  // --- Toast Notifications ---
  function showToast(msg) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-emerald)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      <span>${escapeHtml(msg)}</span>
    `;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.2s ease';
      setTimeout(() => toast.remove(), 200);
    }, 2500);
  }

  // --- Theme Toggle ---
  function initTheme() {
    const saved = localStorage.getItem('tempr-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);

    document.getElementById('themeBtn').addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('tempr-theme', next);
    });
  }

  // --- Hash Router ---
  function handleRoute() {
    const hash = window.location.hash.slice(1);
    if (!hash || hash.startsWith('doc/')) {
      switchView('docs');
      const parts = hash.split('#');
      const docId = parts[0] ? parts[0].replace('doc/', '') : '00-introduction';
      renderDocument(docId);
      if (parts[1]) {
        const el = document.getElementById(parts[1]);
        if (el) el.scrollIntoView({ behavior: 'instant' });
      }
    } else if (hash === 'explorer') {
      switchView('explorer');
    } else if (hash === 'playground') {
      switchView('playground');
    }
  }

  // --- Initialization ---
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('.version-tag').textContent = window.TEMPR_VERSION || 'preview';
    initTheme();
    populateSidebar();
    buildSearchIndex();

    // Top Nav Tabs
    document.getElementById('tabDocs').addEventListener('click', () => {
      location.hash = `#doc/${currentDocId}`;
    });
    document.getElementById('tabExplorer').addEventListener('click', () => {
      location.hash = '#explorer';
    });

    // Mobile Sidebar Toggle
    document.getElementById('mobileMenuBtn').addEventListener('click', () => {
      const open = document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('mobileMenuBtn').setAttribute('aria-expanded', String(open));
    });

    // Search Trigger & Modal
    document.getElementById('searchBtn').addEventListener('click', openSearch);
    document.getElementById('modalSearchInput').addEventListener('input', (e) => {
      handleSearch(e.target.value);
    });

    document.getElementById('searchModal').addEventListener('click', (e) => {
      if (e.target.id === 'searchModal') closeSearch();
    });

    // Keyboard Shortcuts (Cmd+K, Esc)
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openSearch();
      }
      if (e.key === 'Escape') {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('mobileMenuBtn').setAttribute('aria-expanded', 'false');
        closeSearch();
      }
    });

    // Quick Action Links in TOC
    document.getElementById('tocLaunchPlayground').addEventListener('click', () => {
      location.hash = '#playground';
    });
    document.getElementById('tocLaunchExplorer').addEventListener('click', () => {
      location.hash = '#explorer';
    });

    // Explorer Stepper Cards
    document.querySelectorAll('.step-card').forEach(card => {
      card.addEventListener('click', () => {
        updateExplorerStep(parseInt(card.dataset.step));
      });
    });

    document.getElementById('btnResetExplorer').addEventListener('click', () => {
      updateExplorerStep(0);
    });

    document.getElementById('btnRunTimeTravel').addEventListener('click', runTimeTravelQuery);

    // Playground Actions
    document.getElementById('sampleSelect').addEventListener('change', (e) => {
      loadPlaygroundSample(e.target.value);
    });
    document.getElementById('btnRunPlayground').addEventListener('click', runPlaygroundScript);
    document.getElementById('btnClearPlayground').addEventListener('click', () => {
      document.getElementById('playgroundCode').value = '';
    });
    document.getElementById('btnClearOutput').addEventListener('click', () => {
      document.getElementById('playgroundOutput').innerHTML = '<span class="term-comment"># Output cleared.</span>';
    });

    // Cmd+Enter to Run in Playground
    document.getElementById('playgroundCode').addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        runPlaygroundScript();
      }
    });

    // Route on initial load & hashchange
    window.addEventListener('hashchange', handleRoute);
    handleRoute();
  });

})();

/* A restartable embedded client. See docs/OPERATIONS.md for host policies.
 * Run twice against the same directory: retry tokens prevent duplicate work. */
#include "tempr.h"
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static tr_engine *engine;
static int64_t knowledge = 10 * TR_SEC;
static int64_t clock_fn(void *ctx) {
  (void)ctx;
  return knowledge;
}
static void check(tr_status st) {
  if (st == TR_OK)
    return;
  fprintf(stderr, "%s: %s\n", tr_status_name(st),
          engine ? tr_last_error(engine)->msg : "open failed");
  if (st == TR_E_IO)
    fprintf(stderr, "Outcome unknown: restart and retry the same "
                    "client/sequence/content.\n");
  if (st == TR_E_RESOURCE_LIMIT || st == TR_E_RESYNC_REQUIRED)
    fprintf(stderr, "Pause input and resolve capacity or rebuild the "
                    "subscriber snapshot.\n");
  exit(1);
}

/* A real sink must apply each complete output transaction atomically. */
static void drain(tr_view *v, tr_sub **sub) {
  for (;;) {
    const tr_output *o = NULL;
    tr_status st = tr_sub_next(*sub, &o);
    if (st == TR_E_RESYNC_REQUIRED) {
      tr_table *snapshot;
      tr_unsubscribe(*sub);
      check(tr_subscribe(engine, v, sub, &snapshot));
      printf("resnapshot at commit %" PRIu64 " (%" PRIu64 " rows)\n",
             snapshot->commit_seq, snapshot->nrows);
      /* Replace the external replica with this entire snapshot here. */
      tr_table_free(snapshot);
      continue;
    }
    check(st);
    if (!o)
      return;
    printf("durable output commit %" PRIu64 ": %u changes\n", o->commit_seq,
           o->nchanges);
    tr_output_release(o);
  }
}

static void verify(tr_view *v, uint64_t seq, double turnover) {
  tr_query_spec q = {.mode = TR_Q_ALL, .at_seq = seq != 0, .seq = seq};
  tr_table *t;
  check(tr_query(engine, v, &q, &t));
  int tc = tr_schema_find(t->schema, "turnover"),
      vc = tr_schema_find(t->schema, "volume");
  int pc = tr_schema_find(t->schema, "vwap");
  if (t->nrows != 1 || tc < 0 || vc < 0 || pc < 0 ||
      t->cols[tc].vals[0].f != turnover || t->cols[vc].vals[0].i != 3 ||
      t->cols[pc].vals[0].f != turnover / 3) {
    fprintf(stderr, "verification failed\n");
    exit(1);
  }
  tr_table_free(t);
}

int main(int argc, char **argv) {
  const char *dir = NULL;
  bool verify_only = false;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--verify-only"))
      verify_only = true;
    else if (argv[i][0] == '-') {
      fprintf(stderr, "usage: durable_vwap DATA_DIR [--verify-only]\n");
      return 2;
    } else if (!dir)
      dir = argv[i];
    else {
      fprintf(stderr, "usage: durable_vwap DATA_DIR [--verify-only]\n");
      return 2;
    }
  }
  if (!dir) {
    fprintf(stderr, "usage: durable_vwap DATA_DIR [--verify-only]\n");
    return 2;
  }
  if (strcmp(TR_VERSION, tr_version())) {
    fprintf(stderr, "header/runtime mismatch\n");
    return 1;
  }
  tr_config cfg = {.clock = clock_fn,
                   .max_resident_bytes = 64 << 20,
                   .max_operator_bytes = 16 << 20,
                   .max_symbol_bytes = 1 << 20,
                   .max_txn_bytes = 4 << 20,
                   .max_txn_ops = 1000,
                   .max_events = 10000,
                   .max_windows = 100,
                   .max_view_keys = 1000,
                   .max_queue_bytes = 1 << 20,
                   .max_query_bytes = 16 << 20,
                   .max_clients = 4,
                   .dedup_window = 16,
                   .wal_dir = dir,
                   .max_disk_bytes = 64 << 20,
                   .wal_segment_bytes = 1 << 20,
                   .group_commit_bytes = 1 << 20};
  tr_error err;
  tr_status st = tr_open(&cfg, &engine, &err);
  if (st) {
    fprintf(stderr, "%s: %s\n", tr_status_name(st), err.msg);
    return 1;
  }
  tr_field f[] = {{"id", TR_I64, false},
                  {"time", TR_TS, false},
                  {"price", TR_F64, false},
                  {"qty", TR_I64, false}};
  tr_source_policy p;
  tr_source_policy_init(&p);
  p.id_field = "id";
  p.time_field = "time";
  p.window_ns = TR_SEC;
  p.origin_ns = 0;
  p.allow_lateness_ns = 0;
  p.correction_grace_ns = 2 * TR_SEC;
  p.history_after_seal_ns = 10 * TR_SEC;
  p.max_future_skew_ns = 0;
  p.max_pending = 0;
  p.on_late = p.on_closed_correction = TR_REJECT;
  p.cursor = TR_CURSOR_EXPLICIT;
  p.watermark = TR_WM_EXPLICIT;
  tr_source *s;
  check(tr_source_create(engine, "trades", f, 4, &p, &s));
  tr_node *n;
  check(tr_node_source(engine, "trades", &n));
  check(tr_node_tumble(engine, n, TR_SEC, "time", &n));
  tr_agg a[] = {{"volume", TR_AGG_SUM, tr_x_col("qty"), NULL},
                {"turnover", TR_AGG_SUM,
                 tr_x_bin(TR_X_MUL, tr_x_col("price"), tr_x_col("qty")), NULL}};
  check(tr_node_aggregate(engine, n, 1, (const char *const[]){"window"}, 2, a,
                          &n));
  check(tr_node_derive(engine, n, 1, (const char *const[]){"vwap"},
                       (tr_expr *[]){tr_x_bin(TR_X_DIV, tr_x_col("turnover"),
                                              tr_x_col("volume"))},
                       &n));
  tr_view *v;
  check(tr_view_create(engine, "vwap", n, &v));
  tr_start_info recovered;
  check(tr_start(engine, &recovered));
  printf("tempr %s recovered commit %" PRIu64 "\n", tr_version(),
         recovered.commit_seq);
  tr_sub *sub;
  tr_table *snapshot;
  check(tr_subscribe(engine, v, &sub, &snapshot));
  tr_table_free(snapshot);
  if (!verify_only) {
    tr_txn *t;
    tr_commit_info info;
    check(tr_begin_token(engine, 1, 1, &t));
    check(tr_advance_cursor(t, s, 10 * TR_SEC));
    check(tr_advance_watermark(t, s, 9 * TR_SEC));
    tr_cell row[] = {{.i = 1}, {.i = 10 * TR_SEC}, {.f = 100}, {.i = 2}};
    check(tr_insert(t, s, row, 15));
    row[0].i = 2;
    row[2].f = 200;
    row[3].i = 1;
    check(tr_insert(t, s, row, 15));
    check(tr_commit(t, &info));
    printf("batch 1: commit %" PRIu64 ", duplicate=%d, durable=%d\n",
           info.commit_seq, info.duplicate, info.durable);
    /* Low-traffic input is complete: flush now, rather than waiting for the
     * byte threshold. */
    check(tr_sync(engine));
    drain(v, &sub);
    knowledge += TR_SEC / 2;
    check(tr_begin_token(engine, 1, 2, &t));
    row[2].f = 101;
    check(tr_correct(t, s, 1, 1, 1 << 2, row, 15));
    check(tr_commit(t, &info));
    printf("batch 2: commit %" PRIu64 ", duplicate=%d, durable=%d\n",
           info.commit_seq, info.duplicate, info.durable);
    check(tr_sync(engine));
    drain(v, &sub);
  }
  verify(v, 0, 402);
  verify(v, 1, 400);
  if (!verify_only)
    check(tr_checkpoint(engine));
  tr_stats stats;
  tr_stats_get(engine, &stats);
  printf("verified: turnover=402 volume=3 vwap=134 historical_turnover=400 "
         "durable=%" PRIu64 "\n",
         stats.durable_seq);
  check(tr_sync(engine)); /* close cannot report a flush error */
  tr_unsubscribe(sub);
  tr_close(engine);
  return 0;
}

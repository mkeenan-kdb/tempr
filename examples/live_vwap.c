/* Minimal embedded application: subscribe, amend a trade, read past knowledge.
 * Build/run: make example. All errors are fatal in this demonstration. */
#include "tempr.h"
#include <stdio.h>
#include <stdlib.h>
static int64_t now;
static int64_t clock_fn(void *ctx) {
  (void)ctx;
  return now;
}
static void checked(tr_status status) {
  if (status) {
    fprintf(stderr, "%s\n", tr_status_name(status));
    exit(1);
  }
}
int main(void) {
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
                   .max_query_bytes = 16 << 20};
  tr_engine *e;
  checked(tr_open(&cfg, &e, NULL));
  tr_field fields[] = {{"id", TR_I64, false},
                       {"time", TR_TS, false},
                       {"price", TR_F64, false},
                       {"qty", TR_I64, false}};
  tr_source_policy p;
  tr_source_policy_init(&p);
  p.id_field = "id";
  p.time_field = "time";
  p.window_ns = TR_HOUR;
  p.origin_ns = 0;
  p.allow_lateness_ns = 0;
  p.correction_grace_ns = 10 * TR_MIN;
  p.history_after_seal_ns = TR_DAY;
  p.max_future_skew_ns = 0;
  p.max_pending = 0;
  p.on_late = p.on_closed_correction = TR_REJECT;
  p.cursor = TR_CURSOR_KNOWLEDGE;
  p.watermark = TR_WM_EXPLICIT;
  tr_source *s;
  checked(tr_source_create(e, "trades", fields, 4, &p, &s));
  tr_node *n;
  checked(tr_node_source(e, "trades", &n));
  checked(tr_node_tumble(e, n, TR_HOUR, "time", &n));
  tr_agg a = {"vwap", TR_AGG_WAVG, tr_x_col("qty"), tr_x_col("price")};
  checked(
      tr_node_aggregate(e, n, 1, (const char *const[]){"window"}, 1, &a, &n));
  tr_view *v;
  checked(tr_view_create(e, "vwap", n, &v));
  tr_sub *sub;
  tr_table *snapshot;
  checked(tr_subscribe(e, v, &sub, &snapshot));
  tr_table_free(snapshot);
  now = 10 * TR_HOUR;
  tr_txn *t;
  checked(tr_begin(e, &t));
  tr_cell row[] = {{.i = 1}, {.i = now}, {.f = 200}, {.i = 100}};
  checked(tr_insert(t, s, row, 15));
  checked(tr_commit(t, NULL));
  now += TR_MIN;
  checked(tr_begin(e, &t));
  row[2].f = 204;
  checked(tr_correct(t, s, 1, 1, 1 << 2, row, 15));
  checked(tr_commit(t, NULL));
  const tr_output *o;
  for (;;) {
    checked(tr_sub_next(sub, &o));
    if (!o)
      break;
    for (uint32_t i = 0; i < o->nchanges; i++)
      if (o->changes[i].new_row)
        printf("commit %llu: VWAP %.2f\n", (unsigned long long)o->commit_seq,
               o->changes[i].new_row[1].f);
    tr_output_release(o);
  }
  tr_query_spec q = {.mode = TR_Q_AT,
                     .t_ns = 10 * TR_HOUR,
                     .known_at = true,
                     .known_ns = 10 * TR_HOUR};
  checked(tr_query(e, v, &q, &snapshot));
  if (snapshot->nrows != 1 || snapshot->cols[1].vals[0].f != 200)
    return 1;
  printf("as known before the correction: %.2f\n", snapshot->cols[1].vals[0].f);
  tr_table_free(snapshot);
  tr_unsubscribe(sub);
  tr_close(e);
  return 0;
}

/* tempr: temporal incremental analytics engine, public C API. */
#ifndef TEMPR_H
#define TEMPR_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define TR_VERSION "0.3.0"
/* Runtime version; experimental releases do not promise a stable ABI. */
const char *tr_version(void);

typedef enum {
  TR_OK = 0,
  TR_E_TYPE,            /* ill-typed expression or value */
  TR_E_NULL,            /* null in a nonnull field */
  TR_E_OVERFLOW,        /* signed integer overflow or out of range time */
  TR_E_NONFINITE,       /* NaN or infinity as input or computed result */
  TR_E_SCHEMA,          /* malformed schema or row */
  TR_E_NOT_FOUND,       /* unknown name */
  TR_E_RESOURCE_LIMIT,  /* a configured cap would be exceeded */
  TR_E_NOMEM,           /* the allocator failed below the caps */
  TR_E_POLICY,          /* a required policy or cap is missing or invalid */
  TR_E_EXISTS,          /* name already defined */
  TR_E_STATE,           /* call not valid in the current state */
  TR_E_UNSUPPORTED,     /* plan has no supported incremental implementation */
  TR_E_DUPLICATE,       /* insert of a live event id */
  TR_E_ID_REUSE,        /* insert of a deleted event id */
  TR_E_NO_EVENT,        /* correction or delete of an unknown event */
  TR_E_DELETED,         /* correction or delete after deletion */
  TR_E_STALE_REVISION,  /* expected revision is not current */
  TR_E_LATE,            /* new event older than the watermark */
  TR_E_FUTURE,          /* event beyond cursor + max_future_skew */
  TR_E_WINDOW_SEALED,   /* mutation affecting a sealed window */
  TR_E_PROGRESS,        /* watermark or cursor moved backwards, or W > C */
  TR_E_NOT_YET_KNOWN,   /* known_at beyond the latest commit */
  TR_E_BEYOND_CURSOR,   /* at T beyond the event evaluation cursor */
  TR_E_QUERY_BUDGET,    /* historical query exceeded its workspace */
  TR_E_RESYNC_REQUIRED, /* subscriber fell behind and was dropped */
  TR_E_INTERNAL, /* invariant violation; the transaction was rolled back */
  TR_E_IO, /* WAL write or fsync failed: outcome unknown, engine must restart */
  TR_E_CORRUPT,        /* checksum failure inside committed history */
  TR_E_INCOMPATIBLE,   /* the log does not match the registered graph or runtime
                        */
  TR_E_RETRY_EXPIRED,  /* retry token older than the deduplication window */
  TR_E_TOKEN_CONFLICT, /* retry token reused for different content */
  TR_E_HISTORY_UNAVAILABLE, /* outside retained coverage; boundary names the
                               limit */
  TR_E_SYNTAX, /* the language front end could not parse a statement */
  TR_STATUS_COUNT
} tr_status;

const char *tr_status_name(tr_status s);

/* ---- values ---- */

typedef enum { TR_BOOL, TR_I64, TR_F64, TR_SYM, TR_TS, TR_DUR } tr_type;

const char *tr_type_name(tr_type t);

/* Every MVP type fits one 8-byte cell; validity is always carried separately,
 * so the full payload domain is usable (no sentinel nulls).
 * Bool: i = 0/1. Symbol: i = dictionary id. Timestamp: ns since Unix epoch UTC.
 * Duration: ns. */
typedef union {
  int64_t i;
  double f;
} tr_cell;

#define TR_SEC 1000000000LL
#define TR_MIN (60 * TR_SEC)
#define TR_HOUR (60 * TR_MIN)
#define TR_DAY (24 * TR_HOUR)
#define TR_ALL_FIELDS (~0ULL)

typedef struct tr_mem tr_mem;

/* Owned column. Validity follows the Arrow layout: bit i (LSB first) set means
 * valid; valid == NULL means every element is valid. */
typedef struct {
  tr_type type;
  uint64_t len, cap;
  tr_cell *vals;
  uint8_t *valid;
  tr_mem *mem; /* accounting owner, NULL for caller-owned vectors */
  int cat;
} tr_vec;

void tr_vec_init(tr_vec *v, tr_type t);
void tr_vec_free(tr_vec *v);
tr_status tr_vec_push(tr_vec *v, tr_cell c, bool valid);

static inline bool tr_vec_valid(const tr_vec *v, uint64_t i) {
  return !v->valid || (v->valid[i >> 3] >> (i & 7) & 1);
}

/* ---- schemas ---- */

#define TR_MAX_FIELDS 64 /* rows carry validity in one uint64_t */

typedef struct {
  const char *name; /* identifier: [A-Za-z_][A-Za-z0-9_]* */
  tr_type type;
  bool nullable;
} tr_field;

typedef struct tr_schema tr_schema;

tr_status tr_schema_new(const tr_field *fields, uint32_t n, tr_schema **out);
void tr_schema_free(tr_schema *s);
uint32_t tr_schema_len(const tr_schema *s);
const tr_field *tr_schema_field(const tr_schema *s, uint32_t i);
int tr_schema_find(const tr_schema *s, const char *name); /* -1 when absent */

/* Validates a complete row: bit i of `valid` is field i's validity.
 * On failure *bad_field (if non-NULL) names the offending field. */
tr_status tr_row_check(const tr_schema *s, const tr_cell *row, uint64_t valid,
                       int *bad_field);

/* ---- expressions ---- */

typedef enum {
  TR_X_CONST,
  TR_X_COL,
  TR_X_NEG,
  TR_X_NOT,
  TR_X_ISNULL,
  TR_X_ADD,
  TR_X_SUB,
  TR_X_MUL,
  TR_X_DIV,
  TR_X_EQ,
  TR_X_NE,
  TR_X_LT,
  TR_X_LE,
  TR_X_GT,
  TR_X_GE,
  TR_X_AND,
  TR_X_OR,
} tr_xop;

typedef struct tr_expr tr_expr;

/* Constructors take ownership of children and return NULL on allocation
 * failure (freeing any children), so a NULL root means out of memory. */
tr_expr *tr_x_const(tr_type t, tr_cell c, bool valid);
tr_expr *tr_x_i64(int64_t v);
tr_expr *tr_x_f64(double v);
tr_expr *tr_x_null(tr_type t);
/* A symbol constant by name. It is interned when its view is installed, which
 * replay repeats at the same logged position, so ids stay stable. */
tr_expr *tr_x_sym(const char *name);
tr_expr *tr_x_col(const char *name);
tr_expr *tr_x_un(tr_xop op, tr_expr *a);
tr_expr *tr_x_bin(tr_xop op, tr_expr *a, tr_expr *b);
void tr_expr_free(tr_expr *e);

/* Resolves column names against the schema and infers result types. */
tr_status tr_expr_bind(tr_expr *e, const tr_schema *s);
tr_type tr_expr_type(const tr_expr *e);
/* Readable text of an expression, as for explain; returns the full length. */
size_t tr_expr_format(const tr_expr *e, char *buf, size_t n);

/* Evaluates a bound expression over one row. */
tr_status tr_expr_eval(const tr_expr *e, const tr_cell *row, uint64_t valid,
                       tr_cell *out, bool *out_valid);

/* The scalar operator core shared by every evaluator. Null, three valued
 * logic, overflow, division by zero and nonfinite rules live here. */
tr_status tr_op_type(tr_xop op, tr_type a, tr_type b, tr_type *out);
tr_status tr_op_apply(tr_xop op, tr_type ta, tr_cell a, bool va, tr_type tb,
                      tr_cell b, bool vb, tr_cell *out, bool *out_valid);

/* ---- engine ---- */

typedef struct tr_engine tr_engine;
typedef struct tr_source tr_source;
typedef struct tr_node tr_node;
typedef struct tr_view tr_view;
typedef struct tr_txn tr_txn;
typedef struct tr_sub tr_sub;

/* Every cap is required (§4): zero is rejected with TR_E_POLICY. */
typedef struct {
  int64_t (*clock)(
      void *ctx); /* ns since Unix epoch; NULL uses CLOCK_REALTIME */
  void *clock_ctx;
  int64_t max_resident_bytes; /* accounted payloads incl. recovery/compaction;
                                 excludes plans, results, stack/allocator
                                 overhead */
  int64_t max_operator_bytes; /* aggregate state and materialised views */
  /* Names of distinct symbols, each stored once plus a NUL; rows hold 8-byte
   * ids. Symbols are never reclaimed, so allow for every name the engine will
   * see in its lifetime. Its offsets and hash index add up to about 40 bytes
   * per symbol, and the whole dictionary counts in max_resident_bytes. */
  int64_t max_symbol_bytes;
  int64_t max_txn_bytes; /* one transaction's staging workspace */
  int64_t max_txn_ops;
  int64_t max_events;      /* identity entries per source */
  int64_t max_windows;     /* windows per source */
  int64_t max_view_keys;   /* keys per aggregate or materialised view */
  int64_t max_queue_bytes; /* backlog per subscriber */
  int64_t max_query_bytes; /* workspace per historical query */
  /* Retry tokens (tr_begin_token); both are required in durable mode. */
  int64_t max_clients;  /* clients with tracked retry state */
  int64_t dedup_window; /* per client: how many recent sequence numbers stay
                           answerable */
  /* Durable mode: set wal_dir and the fields below. */
  const char *wal_dir;
  int64_t max_disk_bytes;
  int64_t wal_segment_bytes;
  int64_t group_commit_bytes; /* 0: each commit is durable before tr_commit
                                 returns */
  bool unsafe_no_fsync; /* tests only: skip fsync, survive process but not OS
                           crashes */
  bool read_only;       /* replay the log without repairing or writing it */
  int64_t checkpoint_wal_bytes; /* checkpoint once the WAL exceeds this; 0 =
                                   only tr_checkpoint */
} tr_config;

typedef struct {
  tr_status status;
  int32_t op;    /* failing operation within the transaction, -1 if none */
  int32_t field; /* failing field, -1 if none */
  int64_t window_start; /* target window, INT64_MIN if none */
  int64_t boundary; /* watermark, cursor or other bound, INT64_MIN if none */
  char msg[200];
} tr_error;

/* A durable writer locks wal_dir until tr_close; a competing writer returns
 * TR_E_STATE. */
tr_status tr_open(const tr_config *cfg, tr_engine **out, tr_error *err);
void tr_close(tr_engine *e); /* flushes pending group commits */

/* Durable mode: register every source and view first, then start. Start
 * replays the WAL through the same code paths, checking each logged source
 * and view against its registration, then logs whatever is new. Views are
 * installed at their logged position so replay reproduces the original output
 * sequence exactly. Subscriptions made before start receive the replay. */
typedef struct {
  uint64_t checkpoint_seq; /* state loaded from a checkpoint at this commit, 0
                              if none */
  uint64_t commits_replayed, commit_seq;
  int64_t torn_bytes; /* uncommitted tail discarded */
} tr_start_info;

tr_status tr_start(tr_engine *e, tr_start_info *info);

/* Writes and fsyncs pending group commits, then publishes their outputs. */
tr_status tr_sync(tr_engine *e);

/* Frees retired history: events whose every version lies in retired windows,
 * retired window records, and knowledge and cursor history older than the
 * oldest retained version (the knowledge cutoff). Syncs pending commits first.
 * Temporary index maps and replacement payloads share the resident budget
 * with old state; insufficient headroom returns TR_E_RESOURCE_LIMIT. Completed
 * source compactions are not rolled back if a later source fails. */
tr_status tr_compact(tr_engine *e);

/* Durable mode: compacts, writes a checkpoint of the complete retained state,
 * publishes it by atomic rename, then deletes the WAL segments it covers.
 * In memory mode it only compacts. */
tr_status tr_checkpoint(tr_engine *e);
const tr_error *tr_last_error(const tr_engine *e);

tr_status tr_symbol(tr_engine *e, const char *s, int64_t *id);
const char *tr_symbol_name(const tr_engine *e,
                           int64_t id); /* NULL if unknown */

/* ---- sources ---- */

#define TR_UNSET INT64_MIN

typedef enum { TR_POLICY_UNSET, TR_REJECT } tr_reject_policy;
typedef enum {
  TR_CURSOR_UNSET,
  TR_CURSOR_EXPLICIT,
  TR_CURSOR_KNOWLEDGE
} tr_cursor_mode;
typedef enum { TR_WM_UNSET, TR_WM_EXPLICIT, TR_WM_LATENESS } tr_wm_mode;
/* Stored history (durable engines only): sealed windows are written as
 * column files under <wal_dir>/hdb/<source>/, and queries read retired windows
 * from them. MANUAL: tr_store writes them. AUTO: every checkpoint (explicit or
 * checkpoint_wal_bytes) also stores them. Either way a sealed window retires
 * only once stored, so nothing leaves memory unstored. */
typedef enum { TR_STORE_OFF, TR_STORE_MANUAL, TR_STORE_AUTO } tr_store_mode;

/* Initialise with tr_source_policy_init, then set every field: an unset field
 * is rejected (§3). TR_CURSOR_KNOWLEDGE advances the cursor to each commit's
 * knowledge_time; TR_WM_LATENESS sets W = max observed event_time - lateness.
 */
typedef struct {
  const char *id_field;   /* nonnull Int64 */
  const char *time_field; /* nonnull Timestamp */
  int64_t window_ns, origin_ns;
  int64_t allow_lateness_ns, correction_grace_ns, history_after_seal_ns;
  int64_t max_future_skew_ns;
  int64_t max_pending; /* accepted future dated events awaiting the cursor */
  tr_reject_policy on_late, on_closed_correction;
  tr_cursor_mode cursor;
  tr_wm_mode watermark;
  uint32_t generation;
  /* Optional (false by default). A sealed window retires only after
   * tr_advance_exported covers it, so nothing leaves memory unexported; an
   * exporter that stops holds sealed windows, and memory grows. */
  bool export_hold;
  /* Optional (TR_STORE_OFF by default). A stored source's name must be a
   * plain file name: letters, digits, '_', '-' and '.', not starting with '.'.
   */
  tr_store_mode store;
} tr_source_policy;

void tr_source_policy_init(tr_source_policy *p);
tr_status tr_source_create(tr_engine *e, const char *name,
                           const tr_field *fields, uint32_t n,
                           const tr_source_policy *p, tr_source **out);
tr_source *tr_source_find(const tr_engine *e, const char *name);
const tr_schema *tr_source_schema(const tr_source *s);

/* Current version of an event. TR_E_NO_EVENT if never inserted. */
tr_status tr_event_get(tr_engine *e, tr_source *s, int64_t id, uint32_t *rev,
                       bool *deleted, tr_cell *row, uint64_t *valid);

/* RETIRED: history_after_seal has passed on the retention clock (knowledge
 * time). The window leaves memory: its rows leave windowed views without
 * being retracted. Historical queries into it read its stored partition, or
 * return HISTORY_UNAVAILABLE when the source does not store.
 */
typedef enum {
  TR_WIN_OPEN = 1,
  TR_WIN_REVISION_OPEN,
  TR_WIN_SEALED,
  TR_WIN_RETIRED
} tr_window_state;

/* ---- plans ----
 * Builders validate and type check immediately, and take ownership of
 * expressions even on failure. Nodes join the running graph only when
 * tr_view_create installs them (a graph version boundary). */

/* All aggregates support corrections/deletions and window joins. Null values
 * are ignored; count/count_distinct return zero for no nonnull values, other
 * aggregates return null. Empty groups disappear.
 * min/max: Int64, Float64, Timestamp or Duration. first/last: any type, by
 * (source event time, event id), requiring row-level input retaining that time
 * column. count_distinct: any type (+0 and -0 compare equal). any/all: Bool.
 * Ordered/distinct aggregate nodes retain counted values or event keys in
 * operator memory, with expected logarithmic updates; budget for that state. */
typedef enum {
  TR_AGG_COUNT,
  TR_AGG_SUM,
  TR_AGG_AVG,
  TR_AGG_WAVG,
  TR_AGG_MIN,
  TR_AGG_MAX,
  TR_AGG_FIRST,
  TR_AGG_LAST,
  TR_AGG_COUNT_DISTINCT,
  TR_AGG_ANY,
  TR_AGG_ALL
} tr_agg_kind;

typedef struct {
  const char *name;
  tr_agg_kind kind;
  tr_expr *a; /* count: NULL counts rows, else nonnull values; wavg: weight */
  tr_expr *b; /* wavg: value */
} tr_agg;

tr_status tr_node_source(tr_engine *e, const char *source, tr_node **out);
tr_status tr_node_view(tr_engine *e, const char *view, tr_node **out);
tr_status tr_node_tumble(tr_engine *e, tr_node *in, int64_t size_ns,
                         const char *time_col, tr_node **out);
tr_status tr_node_filter(tr_engine *e, tr_node *in, tr_expr *pred,
                         tr_node **out);
tr_status tr_node_derive(tr_engine *e, tr_node *in, uint32_t n,
                         const char *const *names, tr_expr **exprs,
                         tr_node **out);
tr_status tr_node_select(tr_engine *e, tr_node *in, uint32_t n,
                         const char *const *cols, tr_node **out);
tr_status tr_node_aggregate(tr_engine *e, tr_node *in, uint32_t nkeys,
                            const char *const *keys, uint32_t nagg,
                            tr_agg *aggs, tr_node **out);
/* Aligns two views with identical keys (§7 keyed view arithmetic). */
tr_status tr_node_zip(tr_engine *e, tr_node *left, tr_node *right,
                      tr_node **out);

/* Joins each left row to right rows with equal key columns. The left input
 * must be row-level (keyed by event identity) and keep its source's event time
 * column; the output keeps the left key, time and window and appends the right
 * columns whose names are new (EQ, ASOF) or the aggregates (WINDOW).
 *   EQ:     the right row keyed by the join columns: a lookup (kdb lj, ij).
 *   ASOF:   the right row with the greatest time <= the left time, ties to the
 *           greatest right id (kdb aj).
 *   WINDOW: aggregates of right rows with time in [left + lo, left + hi]
 *           (kdb wj1); every left row is kept.
 * ASOF and WINDOW read each side's source event time and need a row-level
 * right input. Outer joins (the default) give null right columns when nothing
 * matches. A right change that would alter an output row whose left window
 * was sealed when the commit began is rejected with TR_E_WINDOW_SEALED. */
typedef enum { TR_JOIN_EQ, TR_JOIN_ASOF, TR_JOIN_WINDOW } tr_join_kind;

typedef struct {
  tr_join_kind kind;
  bool inner; /* EQ, ASOF: drop left rows without a match */
  uint32_t nkeys;
  const char *const *left_keys, *const *right_keys; /* pairwise equal types */
  const char *left_time, *right_time;               /* ASOF, WINDOW */
  int64_t lo_ns, hi_ns;                             /* WINDOW, lo <= hi */
  uint32_t nagg; /* WINDOW: bound to the right schema */
  tr_agg *aggs;  /* taken over as by tr_node_aggregate */
} tr_join;

tr_status tr_node_join(tr_engine *e, tr_node *left, tr_node *right,
                       const tr_join *j, tr_node **out);
tr_status tr_view_create(tr_engine *e, const char *name, tr_node *root,
                         tr_view **out);
tr_view *tr_view_find(const tr_engine *e, const char *name);
const tr_schema *tr_view_schema(const tr_view *v);

/* ---- transactions ----
 * One open transaction per engine. Operations are staged and validated as a
 * whole at commit: any failure rejects the entire transaction and nothing is
 * visible. A failed staging call poisons the transaction. */

typedef struct {
  uint64_t commit_seq;
  int64_t knowledge_ns;
  bool durable;   /* false: accepted and sequenced, awaiting a group sync */
  bool duplicate; /* a retry: the original result, nothing reapplied */
} tr_commit_info;

tr_status tr_begin(tr_engine *e, tr_txn **out);
/* A transaction carrying a retry token. Per client, seq must increase; a
 * retry of a committed (client, seq) with identical content returns the
 * original result within dedup_window. */
tr_status tr_begin_token(tr_engine *e, uint64_t client, uint64_t seq,
                         tr_txn **out);
tr_status tr_insert(tr_txn *t, tr_source *s, const tr_cell *row,
                    uint64_t valid);
/* Replaces the fields in set_mask (TR_ALL_FIELDS for a full row); the rest
 * keep their current values. */
tr_status tr_correct(tr_txn *t, tr_source *s, int64_t id, uint32_t expected_rev,
                     uint64_t set_mask, const tr_cell *row, uint64_t valid);
tr_status tr_delete(tr_txn *t, tr_source *s, int64_t id, uint32_t expected_rev);
tr_status tr_advance_watermark(tr_txn *t, tr_source *s, int64_t w_ns);
tr_status tr_advance_cursor(tr_txn *t, tr_source *s, int64_t c_ns);
/* Records that every window ending at or before end_ns is exported. It never
 * moves backwards, and cannot pass tr_source_info's sealed_end
 * (TR_E_PROGRESS). Logged like any progress, so it survives restarts; with
 * export_hold it releases those windows to retire. */
tr_status tr_advance_exported(tr_txn *t, tr_source *s, int64_t end_ns);
tr_status tr_commit(tr_txn *t, tr_commit_info *info); /* consumes t */
void tr_abort(tr_txn *t);

/* ---- results ---- */

/* A standalone value: it owns its schema and columns and may outlive the
 * engine. */
typedef struct {
  const tr_schema *schema;
  uint64_t nrows, commit_seq;
  int64_t covered_from; /* windows before this are retired and absent;
                           INT64_MIN: complete */
  tr_vec *cols;         /* one per schema field; rows sorted by key */
} tr_table;

void tr_table_free(tr_table *t);

/* Every retained version of every event whose event time is in [lo_ns,
 * hi_ns), in durable commits: the source's columns (all nullable), then
 *   _rev Int64, _deleted Bool (a delete: only the id and time columns are
 *   set), _commit Int64, _known Timestamp (its commit's knowledge time) and
 *   _until Timestamp (when the next version of that event superseded it; null
 *   while current).
 * A version was the known state of its event for knowledge times in
 * [_known, _until). Rows are sorted by event time, id and commit. This is what
 * an exporter writes for sealed windows: with it, "as known at K" can be
 * answered outside tempr after the windows retire. TR_E_HISTORY_UNAVAILABLE
 * when lo_ns is before tr_source_info's retired_before. */
tr_status tr_versions(tr_engine *e, tr_source *s, int64_t lo_ns, int64_t hi_ns,
                      tr_table **out);

typedef struct {
  int64_t from_ns, to_ns; /* windows stored by this call; INT64_MIN: none */
  uint64_t versions;
  uint32_t partitions; /* windows with events; empty windows write nothing */
} tr_store_info;

/* Writes every sealed window not yet stored, then records that in a commit
 * (logged, so it survives restarts) that releases those windows to retire.
 * Each window with events becomes <wal_dir>/hdb/<source>/<start>/, named
 * like 20260930T120000Z (fractional seconds after a '.' if any), holding:
 *   one file per column of little endian 8-byte cells, one per version,
 *   sorted by event time, id and commit: the source's columns (nullable
 *   except the id and event time, which a delete keeps), then
 *   tr_versions' _rev, _deleted, _commit, _known and _until, then
 *   _until_commit (the superseding commit), _visible_commit and
 *   _visible_known (the first commit, and its knowledge time, at which the
 *   version was both committed and within the event cursor);
 *   <column>.valid, an LSB-first bitmap, for each nullable column;
 *   .d: "TRPT", format 1, window start and length, row count, then each
 *   column's name, type, nullability and CRC32C of its files, then a CRC32C.
 * Symbols are ids in the engine's symbols file. Partitions are written to a
 * temporary directory, synced and renamed, so a crash leaves either nothing
 * or a whole partition; a retry rewrites it. Partitions do not count towards
 * max_disk_bytes. Durable engines, outside a transaction, sources whose
 * store policy is not TR_STORE_OFF. info may be NULL. */
tr_status tr_store(tr_engine *e, tr_source *s, tr_store_info *info);

typedef enum {
  TR_Q_ALL,    /* every live fact up to the cursor */
  TR_Q_AT,     /* at T: the window containing T up to T, or event_time <= T */
  TR_Q_WINDOW, /* the whole window containing T, up to the cursor */
  TR_Q_NOW,    /* at the evaluation cursor (§2 "now") */
} tr_qmode;

typedef struct {
  tr_qmode mode;
  int64_t t_ns;
  bool
      known_at; /* select the greatest commit with knowledge_time <= known_ns */
  int64_t known_ns;
  bool at_seq; /* select an exact commit sequence instead */
  uint64_t seq;
  /* Only event times in [from_ns, to_ns), widened to whole windows for the
   * view's window source. It applies to every source the plan reads except
   * any a join reads as its right input, which stay whole so matches at the
   * edges stay exact. With TR_Q_ALL it also reaches retired windows, read
   * from stored partitions (without a range, TR_Q_ALL covers only windows in
   * memory, as covered_from reports). */
  bool range;
  int64_t from_ns, to_ns;
} tr_query_spec;

/* Evaluates the view as of the selected commit. Retired windows are read
 * from stored partitions; a query needing retired history of a source that
 * does not store returns HISTORY_UNAVAILABLE. A commit older than the
 * knowledge cutoff can still be queried when every row it needs is stored;
 * `at T` is then not checked against that commit's cursor. Plans without
 * joins evaluate one partition at a time, so max_query_bytes bounds operator
 * state and one partition, not the whole range; joins read their range at
 * once. */
tr_status tr_query(tr_engine *e, tr_view *v, const tr_query_spec *q,
                   tr_table **out);

/* An ad hoc query: evaluates a plan built with tr_node_* like a view that is
 * never installed, with nothing retained afterwards. The root may also be a
 * source or view node (a source gives its rows). */
tr_status tr_query_plan(tr_engine *e, tr_node *root, const tr_query_spec *q,
                        tr_table **out);

/* Frees an uninstalled plan's nodes: root and its uninstalled inputs, from the
 * most recently created back, stopping at the first node still installed or
 * created after them. Use it after tr_query_plan, or to drop a plan that will
 * not become a view. Installed nodes and view roots are left alone. */
void tr_node_discard(tr_engine *e, tr_node *root);

/* ---- subscriptions ----
 * A subscription starts from a snapshot at commit N and then receives every
 * output transaction with commit_seq > N, complete and in order. A client that
 * needs snapshot consistency applies each output as a unit. Release every
 * output before tr_close. */

typedef struct {
  const tr_cell *old_row, *new_row; /* NULL when absent */
  uint64_t old_valid, new_valid;
} tr_change;

typedef struct {
  int64_t window_start;
  tr_window_state state;
} tr_window_change;

typedef struct {
  uint64_t commit_seq, graph_version;
  int64_t knowledge_ns;
  const tr_schema *schema;
  uint32_t nchanges, nwindows;
  const tr_change *changes;
  const tr_window_change *windows;
} tr_output;

tr_status tr_subscribe(tr_engine *e, tr_view *v, tr_sub **sub,
                       tr_table **snapshot);
/* *out is NULL when nothing is queued. TR_E_RESYNC_REQUIRED once dropped. */
tr_status tr_sub_next(tr_sub *s, const tr_output **out);
void tr_output_release(const tr_output *o);
void tr_unsubscribe(tr_sub *s);

/* ---- inspection (§10) ---- */

#define TR_MEM_KINDS 8
const char *tr_mem_kind_name(int kind); /* data, versions, indexes, symbols,
                                           operators, queues, staging, wal */

typedef struct {
  uint64_t commit_seq, durable_seq, graph_version;
  uint64_t cutoff_seq; /* queries at earlier commits are HISTORY_UNAVAILABLE */
  int64_t knowledge_ns;
  int64_t wal_disk_bytes, wal_pending_bytes;
  uint64_t clock_rollbacks, checkpoint_failures;
  int64_t max_clock_rollback_ns, checkpoint_bytes;
  int64_t resident_bytes, resident_high_water;
  int64_t
      bytes[TR_MEM_KINDS]; /* resident bytes by kind; see tr_mem_kind_name */
  uint64_t rejected[TR_STATUS_COUNT];
} tr_stats;

void tr_stats_get(const tr_engine *e, tr_stats *out);

typedef struct {
  const char *name;
  int64_t cursor, watermark, retired_before; /* INT64_MIN: none yet */
  uint64_t events, versions, pending;
  uint32_t windows[TR_WIN_RETIRED +
                   1];  /* retained window records by tr_window_state */
  int64_t sealed_end;   /* every window ending at or before this has sealed */
  int64_t exported_end; /* ... and at or before this is exported */
  int64_t first_window; /* earliest window not retired; INT64_MIN if none */
  /* Stored windows cover [stored_from, stored_end); INT64_MIN from: from the
   * start. stored_end INT64_MIN: nothing stored yet. */
  int64_t stored_from, stored_end;
} tr_source_info;

typedef struct {
  const char *name;
  bool installed;
  uint64_t rows; /* materialised rows */
} tr_view_info;

uint32_t tr_source_count(const tr_engine *e);
void tr_source_info_get(const tr_engine *e, uint32_t i, tr_source_info *out);
uint32_t tr_view_count(const tr_engine *e);
void tr_view_info_get(const tr_engine *e, uint32_t i, tr_view_info *out);

/* Plan inspection as text: each operator with its retained state, fanout and
 * whether it runs incrementally or only as an offline query. Returns the full
 * length, so a short buffer can be retried. */
size_t tr_explain(const tr_engine *e, const tr_view *v, char *buf, size_t n);
/* Structural dependencies: what the view reads and which views read it. */
size_t tr_dependencies(const tr_engine *e, const tr_view *v, char *buf,
                       size_t n);

#endif

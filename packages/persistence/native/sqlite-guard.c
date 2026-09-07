/* Connection-local capacity guard. Uses Node's SQLite API table; never links a
 * second SQLite library or stores a process-global connection/limit. */
#include "sqlite/sqlite3ext.h"
#ifdef _WIN32
static __declspec(thread) const sqlite3_api_routines *sqlite3_api;
#else
static _Thread_local const sqlite3_api_routines *sqlite3_api;
#endif

typedef struct BellisGuard {
  sqlite3 *db;
  const sqlite3_api_routines *api;
  sqlite3_int64 limit;
  int tripped;
} BellisGuard;

static int guardCheck(void *opaque) {
  BellisGuard *guard = (BellisGuard *)opaque;
  sqlite3_int64 bytes = 0, high = 0;
  /* After an interrupt, permit the adapter's rollback/cache cleanup and reset.
   * The synchronous adapter resets this before exposing the error to callers. */
  if (guard->tripped) return 0;
  if (guard->api->db_status64(guard->db, SQLITE_DBSTATUS_CACHE_USED,
                            &bytes, &high, 0) != SQLITE_OK ||
      bytes < 0 || bytes > guard->limit) {
    guard->tripped = 1;
    return 1;
  }
  return 0;
}

static void guardControl(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  BellisGuard *guard;
  sqlite3_int64 value;
  (void)argc;
  /* Worker connections execute on their owning thread. The ABI lookup is
   * thread-local; all callback quota state belongs to this connection. */
  guard = (BellisGuard *)sqlite3_user_data(ctx);
  value = guard->api->value_int64(argv[0]);
  if (value == -1) {
    guard->api->result_int(ctx, 2); /* Private Worker ABI, including completion budgets. */
  } else if (value == 0) {
    guard->api->result_int(ctx, guard->tripped);
  } else if (value >= 512 * 1024 && value <= 64 * 1024 * 1024) {
    guard->limit = value;
    guard->tripped = 0;
    guard->api->result_int64(ctx, value);
  } else {
    guard->api->result_error(ctx, "invalid transaction capacity", -1);
  }
}

static void guardDestroy(void *opaque) {
  BellisGuard *guard = (BellisGuard *)opaque;
  guard->api->free(guard);
}

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_bellisguard_init(sqlite3 *db, char **error,
                            const sqlite3_api_routines *api) {
  BellisGuard *guard;
  int rc;
  (void)error;
  SQLITE_EXTENSION_INIT2(api);
  if (api->libversion_number() < 3051000) return SQLITE_ERROR;
  guard = (BellisGuard *)api->malloc((int)sizeof(*guard));
  if (!guard) return SQLITE_NOMEM;
  guard->db = db;
  guard->api = api;
  guard->limit = 8 * 1024 * 1024;
  guard->tripped = 0;
  rc = api->create_function_v2(db, "bellis_guard", 1, SQLITE_UTF8 | SQLITE_DIRECTONLY,
                             guard, guardControl, 0, 0, guardDestroy);
  if (rc != SQLITE_OK) return rc; /* create_function_v2 invokes the destructor. */
  api->commit_hook(db, guardCheck, guard);
  api->progress_handler(db, 32, guardCheck, guard);
  return SQLITE_OK;
}

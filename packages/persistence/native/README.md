# SQLite transaction capacity guard

`sqlite-guard.c` loads into the SQLite already embedded in Node. It does not link or bundle another SQLite engine. Per-connection state owns the cache budget; the small API lookup used to obtain callback user data is thread-local. Worker connections execute on their owning thread.

The progress callback checks pager-cache consumption with `sqlite3_db_status64` every 32 VM instructions. The commit hook performs the same check before commit and converts an over-budget commit to rollback. Neither hook runs SQL or modifies its owning SQLite connection. Once a check trips, callbacks permit the synchronous adapter's rollback/cache cleanup; the adapter resets the guard before returning the safe error. Cache spilling is disabled and repository SQL cannot change it, change page limits, attach another database, load code, or reset the guard.

This budget covers pager-cache bytes, including clean pages. It is not a process RSS limit or a limit on every temporary SQLite allocation. The progress interval permits temporary overshoot; the commit check still rejects an oversized set of cached page images before writing its WAL frames. SQLite 3.51.0 or newer is required for `db_status64`.

`pnpm build` compiles the source into `dist/native` using `cc` on macOS/Linux or `cl.exe` in a Visual Studio Developer shell on Windows. No network access is needed at build time. Compiler flags treat warnings as errors. Build metadata hashes the source, headers, build script, platform, architecture and binary to reject stale build-cache entries. The runtime loads the fixed package-local binary and immediately disables further extension loading. Missing or incompatible binaries fail startup; there is no unguarded fallback.

The two headers are unmodified public-domain SQLite 3.53.4 distribution files from the [official amalgamation archive](https://www.sqlite.org/2026/sqlite-amalgamation-3530400.zip):

- Archive SHA-256: `1e71ddf93849c6a6ecf58b827c0692073d2dd7ee40196158068f7b29f422e87d`.
- `sqlite3.h`: `919e7f2e8ed1d8f56ac17b412b8971c76aa5d1a879752cc6058f75e7d5910e1d`.
- `sqlite3ext.h`: `ac9645e5c9ff0cf176efdd6e75cb5e98f46295d38e02db5c4d208826a39ab4be`.

The headers provide ABI declarations only. The running SQLite version remains Node's version. See [SQLite commit hook](https://www.sqlite.org/c3ref/commit_hook.html), [connection status](https://www.sqlite.org/c3ref/c_dbstatus_options.html), and the Phase 4 transaction-capacity ADR for scope and evidence.

For admitted effect completion, the Worker temporarily uses smaller private budgets (512 KiB for binding/close, 2 MiB for confirmation at 4 KiB pages). Larger database pages scale these budgets. The public ordinary-transaction option still has a 4 MiB minimum; repository SQL cannot set the guard directly. The scope remains active during the private before-commit checkpoint and is restored after commit or rollback.

The Worker checks private guard ABI version 2 during startup, before accepting work. This rejects an older guard that cannot enforce the smaller completion budgets. Compilation writes a process-specific temporary binary and renames it into place only after the compiler succeeds; build metadata is then refreshed.

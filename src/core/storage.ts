import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import {
  DB_FILENAME,
  DB_SCHEMA_VERSION,
  DEFAULT_RETENTION,
  threadKey,
  type LegacyImportReport,
  type LegacyStoreSnapshot,
  type LogLine,
  type LogQuery,
  type LogRow,
  type ProjectConfig,
  type ProjectId,
  type RetentionPolicy,
  type SessionPage,
  type SessionQuery,
  type SessionRow,
  type Storage,
  type ThreadRecord,
  type TurnQuery,
  type TurnRow,
} from '../shared/contract.ts';
import { logger } from './log.ts';

const log = logger('storage');

/**
 * Threads, cursors, turns and log lines, on the BUILT-IN `node:sqlite`.
 *
 * Every SQL string in the app lives in this file. That is the whole point of
 * the narrow `Storage` interface: swapping the engine later touches one module.
 *
 * `better-sqlite3` is deliberately not used. It is a native module and would
 * need an electron-rebuild against Electron's ABI on every upgrade, while
 * `node:sqlite` ships inside Node and therefore inside Electron, so there is no
 * native build step at all.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  channel              TEXT    NOT NULL,
  thread_ts            TEXT    NOT NULL,
  session_id           TEXT,
  project_id           TEXT,
  alias                TEXT,
  cwd                  TEXT    NOT NULL,
  slack_user           TEXT    NOT NULL,
  created_at           INTEGER NOT NULL,
  last_active_at       INTEGER NOT NULL,
  turn_count           INTEGER NOT NULL DEFAULT 0,
  cost_usd             REAL    NOT NULL DEFAULT 0,
  rejected_notified_at INTEGER,
  orphan_notified_at   INTEGER,
  PRIMARY KEY (channel, thread_ts)
);
CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);
CREATE INDEX IF NOT EXISTS idx_threads_active  ON threads(channel, last_active_at DESC);
-- sessions() sorts across ALL channels, which idx_threads_active cannot serve
-- because its leading column is the channel. Measured: without this the plan is
-- SCAN threads + USE TEMP B-TREE FOR ORDER BY on every page.
CREATE INDEX IF NOT EXISTS idx_threads_last_active ON threads(last_active_at DESC);

CREATE TABLE IF NOT EXISTS cursors (
  channel TEXT PRIMARY KEY,
  last_ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel     TEXT    NOT NULL,
  thread_ts   TEXT    NOT NULL,
  project_id  TEXT,
  alias       TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  tool_count  INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL    NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  subtype     TEXT    NOT NULL DEFAULT 'success',
  error       TEXT,
  preview     TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_turns_started ON turns(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_turns_project ON turns(project_id, started_at DESC);
-- Load-bearing for sessions(): neither index above is keyed by thread, so the
-- correlated subquery would scan the whole turns table ONCE PER THREAD ROW,
-- against a table that keeps 180 days by DEFAULT_RETENTION. Measured: with this
-- it is SEARCH turns USING COVERING INDEX (channel=? AND thread_ts=?).
CREATE INDEX IF NOT EXISTS idx_turns_thread  ON turns(channel, thread_ts, started_at DESC);

CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  level   TEXT    NOT NULL,
  scope   TEXT    NOT NULL,
  message TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_at    ON logs(at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level, at DESC);
`;

type ThreadRow = {
  channel: string;
  thread_ts: string;
  session_id: string | null;
  project_id: string | null;
  alias: string | null;
  cwd: string;
  slack_user: string;
  created_at: number;
  last_active_at: number;
  turn_count: number;
  cost_usd: number;
  rejected_notified_at: number | null;
  orphan_notified_at: number | null;
};

type TurnDbRow = {
  id: number;
  channel: string;
  thread_ts: string;
  project_id: string | null;
  alias: string | null;
  started_at: number;
  ended_at: number;
  duration_ms: number;
  tool_count: number;
  cost_usd: number;
  failed: number;
  subtype: string;
  error: string | null;
  preview: string;
};

/**
 * A `threads` row joined to its newest `turns` row. Every `u.*` column is
 * nullable because the join is a LEFT one: a thread that never ran a turn has
 * no turn to carry.
 */
type SessionDbRow = {
  channel: string;
  thread_ts: string;
  session_id: string | null;
  project_id: string | null;
  alias: string | null;
  cwd: string;
  slack_user: string;
  created_at: number;
  last_active_at: number;
  turn_count: number;
  started_at: number | null;
  duration_ms: number | null;
  tool_count: number | null;
  failed: number | null;
  subtype: string | null;
  error: string | null;
  preview: string | null;
};

type LogDbRow = { id: number; at: number; level: string; scope: string; message: string };

function toEpoch(iso: string | undefined, fallback: number): number {
  if (!iso) return fallback;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toIso(epoch: number): string {
  return new Date(epoch).toISOString();
}

function toRecord(row: ThreadRow): ThreadRecord {
  const record: ThreadRecord = {
    sessionId: row.session_id ?? '',
    cwd: row.cwd,
    slackUserId: row.slack_user,
    createdAt: toIso(row.created_at),
    lastActiveAt: toIso(row.last_active_at),
    turns: row.turn_count,
    costUsd: row.cost_usd,
    projectId: row.project_id,
    alias: row.alias,
  };
  if (row.rejected_notified_at != null) record.rejectedNotifiedAt = toIso(row.rejected_notified_at);
  if (row.orphan_notified_at != null) record.orphanNotifiedAt = toIso(row.orphan_notified_at);
  return record;
}

class SqliteStorage implements Storage {
  private readonly db: DatabaseSync;
  /**
   * Statements are prepared on first use and reused forever, so the hot path
   * (one thread read, one cursor write, one log append per message) never calls
   * `prepare()` again.
   */
  private readonly statements = new Map<string, StatementSync>();
  private closed = false;
  // Written out rather than declared as a constructor parameter property:
  // Node's type stripping cannot handle those, and `npm test` runs this file.
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.db = new DatabaseSync(file);

    // WAL plus NORMAL is the durable-enough, fast pairing for a desktop app.
    const mode = this.db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | undefined;
    if (mode?.journal_mode !== 'wal') {
      log.warn(`journal_mode is ${mode?.journal_mode ?? 'unknown'}, expected wal`);
    }
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');

    this.migrate();
  }

  private stmt(sql: string): StatementSync {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  private all<T>(sql: string, params: SQLInputValue[] = []): T[] {
    return this.stmt(sql).all(...params) as unknown as T[];
  }

  private one<T>(sql: string, params: SQLInputValue[] = []): T | undefined {
    return this.stmt(sql).get(...params) as unknown as T | undefined;
  }

  private run(sql: string, params: SQLInputValue[] = []): void {
    this.stmt(sql).run(...params);
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    const version = Number(row?.user_version ?? 0);

    if (version === DB_SCHEMA_VERSION) return;
    if (version > DB_SCHEMA_VERSION) {
      log.warn(`database schema is version ${version}, newer than this build expects (${DB_SCHEMA_VERSION})`);
      return;
    }

    // Version 0 is a fresh file. Later versions add their ALTERs here, in
    // ascending order, each falling through to the next. v2 needed none: it
    // only adds idx_turns_thread and idx_threads_last_active, and every
    // statement in SCHEMA is IF NOT EXISTS, so re-execing it IS the migration.
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${DB_SCHEMA_VERSION}`);
    if (version === 0) log.info(`initialised schema v${DB_SCHEMA_VERSION} at ${this.file}`);
    else log.info(`migrated schema v${version} to v${DB_SCHEMA_VERSION}`);
  }

  // --- threads -------------------------------------------------------------

  getThread(channel: string, threadTs: string): ThreadRecord | undefined {
    const row = this.one<ThreadRow>('SELECT * FROM threads WHERE channel = ? AND thread_ts = ?', [channel, threadTs]);
    return row ? toRecord(row) : undefined;
  }

  putThread(channel: string, threadTs: string, record: ThreadRecord): void {
    const now = Date.now();
    this.run(
      `INSERT INTO threads
         (channel, thread_ts, session_id, project_id, alias, cwd, slack_user,
          created_at, last_active_at, turn_count, cost_usd, rejected_notified_at, orphan_notified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel, thread_ts) DO UPDATE SET
         session_id = excluded.session_id,
         project_id = excluded.project_id,
         alias = excluded.alias,
         cwd = excluded.cwd,
         slack_user = excluded.slack_user,
         last_active_at = excluded.last_active_at,
         turn_count = excluded.turn_count,
         cost_usd = excluded.cost_usd,
         rejected_notified_at = excluded.rejected_notified_at,
         orphan_notified_at = excluded.orphan_notified_at`,
      // Coalesced rather than passed straight through: SQLInputValue has no
      // undefined, and a patch that clears a field must land as NULL or 0.
      [
        channel,
        threadTs,
        record.sessionId || null,
        record.projectId ?? null,
        record.alias ?? null,
        record.cwd ?? '',
        record.slackUserId ?? '',
        toEpoch(record.createdAt, now),
        toEpoch(record.lastActiveAt, now),
        record.turns ?? 0,
        record.costUsd ?? 0,
        record.rejectedNotifiedAt ? toEpoch(record.rejectedNotifiedAt, now) : null,
        record.orphanNotifiedAt ? toEpoch(record.orphanNotifiedAt, now) : null,
      ],
    );
  }

  /**
   * Key PRESENCE decides: a key set to `undefined` CLEARS that field, a key
   * that is absent leaves it alone. That is what lets the service clear the
   * "already told this thread" flags when a project comes back, and `null` on
   * projectId/alias is a real unbind.
   */
  patchThread(channel: string, threadTs: string, patch: Partial<ThreadRecord>): void {
    const existing = this.getThread(channel, threadTs);
    if (!existing) return;
    this.putThread(channel, threadTs, { ...existing, ...patch });
  }

  /**
   * Forget one thread: the `threads` row and every `turns` row under it.
   *
   * One explicit BEGIN/COMMIT, not two bare DELETEs. A crash between them would
   * leave turn rows whose thread is gone: nothing in the app joins to them, so
   * they are invisible until `prune()` collects them 180 days later by
   * DEFAULT_RETENTION. Explicit transactions were verified working on this
   * `node:sqlite` build, which the Storage doc comment in the contract records.
   *
   * The `cursors` row for this channel is left alone, and that is load-bearing
   * rather than an oversight. A cursor is per CHANNEL, and several threads share
   * one. Deleting it re-seeds the channel, so the next catch-up replays a day of
   * old DMs and re-runs those turns under bypassPermissions, which is the exact
   * bug `advanceCursor` above exists to prevent.
   *
   * The count comes from the DELETE's own `changes` rather than a COUNT(*)
   * first, so what is reported is what was actually removed.
   */
  deleteSession(channel: string, threadTs: string): { turns: number } {
    this.db.exec('BEGIN');
    try {
      const removed = this.stmt('DELETE FROM turns WHERE channel = ? AND thread_ts = ?').run(channel, threadTs);
      this.run('DELETE FROM threads WHERE channel = ? AND thread_ts = ?', [channel, threadTs]);
      this.db.exec('COMMIT');
      return { turns: Number(removed.changes ?? 0) };
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch (rollbackError) {
        // SQLite may have rolled the transaction back itself, which makes this
        // ROLLBACK a "no transaction is active" error. The original failure is
        // the one worth propagating.
        log.debug('rollback after a failed deleteSession failed', rollbackError);
      }
      throw error;
    }
  }

  threadsFor(channel: string, since?: number): { key: string; record: ThreadRecord }[] {
    const rows =
      since === undefined
        ? this.all<ThreadRow>('SELECT * FROM threads WHERE channel = ? ORDER BY last_active_at DESC', [channel])
        : this.all<ThreadRow>(
            'SELECT * FROM threads WHERE channel = ? AND last_active_at >= ? ORDER BY last_active_at DESC',
            [channel, since],
          );
    return rows.map((row) => ({ key: threadKey(row.channel, row.thread_ts), record: toRecord(row) }));
  }

  threadsForProject(projectId: ProjectId): { key: string; record: ThreadRecord }[] {
    const rows = this.all<ThreadRow>('SELECT * FROM threads WHERE project_id = ? ORDER BY last_active_at DESC', [projectId]);
    return rows.map((row) => ({ key: threadKey(row.channel, row.thread_ts), record: toRecord(row) }));
  }

  countThreads(): number {
    return Number(this.one<{ n: number }>('SELECT COUNT(*) AS n FROM threads')?.n ?? 0);
  }

  // --- cursors -------------------------------------------------------------

  getCursor(channel: string): string | undefined {
    return this.one<{ last_ts: string }>('SELECT last_ts FROM cursors WHERE channel = ?', [channel])?.last_ts;
  }

  /**
   * The single most important statement in this file. Without a persisted
   * cursor a restart replays a day of old DMs and re-runs those turns under
   * bypassPermissions, which was a real bug. Slack timestamps are numeric
   * strings, so the comparison must be numeric: lexicographically "9.5" sorts
   * after "10.1".
   */
  advanceCursor(channel: string, ts: string): void {
    this.run(
      `INSERT INTO cursors(channel, last_ts) VALUES(?, ?)
       ON CONFLICT(channel) DO UPDATE SET last_ts = excluded.last_ts
         WHERE CAST(excluded.last_ts AS REAL) > CAST(cursors.last_ts AS REAL)`,
      [channel, ts],
    );
  }

  allCursors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.all<{ channel: string; last_ts: string }>('SELECT channel, last_ts FROM cursors')) {
      out[row.channel] = row.last_ts;
    }
    return out;
  }

  // --- turns ---------------------------------------------------------------

  recordTurn(turn: Omit<TurnRow, 'id'>): void {
    // A turn that ENDS after its thread was removed must not put a row back.
    // The service refuses a remove while a turn is running, but it can only see
    // sessions still in its map, and both a graceful stop and a paused project
    // drop a still-draining session out of it. Measured without this guard: the
    // delete reports success, then the late turn inserts a row that sessions()
    // cannot show (it joins from threads) but recentTurns still surfaces, prompt
    // preview and all, until retention sweeps it 180 days later.
    //
    // Same shape as patchThread: no thread row, no write.
    const thread = this.one<{ n: number }>('SELECT 1 AS n FROM threads WHERE channel = ? AND thread_ts = ?', [
      turn.channel,
      turn.threadTs,
    ]);
    if (!thread) {
      log.debug(`dropped a turn for ${turn.channel}:${turn.threadTs}, which is no longer a thread`);
      return;
    }

    this.run(
      `INSERT INTO turns
         (channel, thread_ts, project_id, alias, started_at, ended_at, duration_ms,
          tool_count, cost_usd, failed, subtype, error, preview)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        turn.channel,
        turn.threadTs,
        turn.projectId,
        turn.alias,
        turn.startedAt,
        turn.endedAt,
        turn.durationMs,
        turn.toolCount,
        turn.costUsd,
        turn.failed ? 1 : 0,
        turn.subtype,
        turn.error ?? null,
        turn.preview,
      ],
    );
  }

  recentTurns(query: TurnQuery = {}): TurnRow[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (query.projectId) {
      where.push('project_id = ?');
      params.push(query.projectId);
    }
    if (query.failedOnly) where.push('failed = 1');
    if (query.since !== undefined) {
      where.push('started_at >= ?');
      params.push(query.since);
    }
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
    const sql = `SELECT * FROM turns${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`;
    params.push(limit);

    return this.all<TurnDbRow>(sql, params).map((row) => {
      const turn: TurnRow = {
        id: row.id,
        channel: row.channel,
        threadTs: row.thread_ts,
        projectId: row.project_id,
        alias: row.alias,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        durationMs: row.duration_ms,
        toolCount: row.tool_count,
        costUsd: row.cost_usd,
        failed: row.failed === 1,
        subtype: row.subtype,
        preview: row.preview,
      };
      if (row.error) turn.error = row.error;
      return turn;
    });
  }

  // --- sessions ------------------------------------------------------------

  /**
   * Every thread, newest active first, one page at a time, each carrying its
   * most recent turn. No new table: `threads` has been the session table all
   * along, this is only the read that was missing.
   */
  sessions(query: SessionQuery = {}): SessionPage {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (query.projectId) {
      where.push('t.project_id = ?');
      params.push(query.projectId);
    }
    // On the LEFT JOIN a session with no turns has u.failed NULL, and `NULL = 1`
    // is NULL, so those rows fail the WHERE and drop out. That is wanted, since
    // "the last turn failed" cannot be true of a session that has never run one,
    // and it is written down because it reads like an accident.
    if (query.failedOnly) where.push('u.failed = 1');
    if (query.since !== undefined) {
      where.push('t.last_active_at >= ?');
      params.push(query.since);
    }

    // Built ONCE and shared by the page and the count below, so the "1-20 of
    // 137" footer can never drift from the rows it is counting.
    //
    // A correlated subquery rather than GROUP BY ... MAX(started_at), because
    // the latter cannot carry the rest of the winning row's columns without a
    // second pass. The bare `channel`/`thread_ts` inside it resolve against the
    // innermost FROM (`turns`) and `t.*` against the outer `threads t`, so the
    // outer `turns u` never enters resolution (measured, not assumed). Matching
    // on `u.id = <scalar subquery>` is a rowid equality, so the join yields at
    // most one turn per thread and COUNT(*) cannot fan out.
    //
    // LEFT, not inner: a thread that was bound but never ran a turn is still a
    // real session and must appear, with an empty "last turn".
    const fromWhere = `FROM threads t
         LEFT JOIN turns u ON u.id = (
               SELECT id FROM turns
                WHERE channel = t.channel AND thread_ts = t.thread_ts
                ORDER BY started_at DESC, id DESC LIMIT 1)
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;

    const limit = Math.min(Math.max(query.limit ?? 20, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);

    const rows = this.all<SessionDbRow>(
      `SELECT t.channel, t.thread_ts, t.session_id, t.project_id, t.alias, t.cwd,
              t.slack_user, t.created_at, t.last_active_at, t.turn_count,
              u.started_at, u.duration_ms, u.tool_count, u.failed, u.subtype,
              u.error, u.preview
         ${fromWhere}
        ORDER BY t.last_active_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ).map((row) => {
      const session: SessionRow = {
        key: threadKey(row.channel, row.thread_ts),
        channel: row.channel,
        threadTs: row.thread_ts,
        sessionId: row.session_id || null,
        projectId: row.project_id,
        alias: row.alias,
        cwd: row.cwd,
        slackUserId: row.slack_user,
        createdAt: row.created_at,
        lastActiveAt: row.last_active_at,
        turns: row.turn_count,
      };
      // started_at is NOT NULL on the turns table, so a null here means the
      // LEFT JOIN found nothing rather than a turn with a missing timestamp.
      if (row.started_at != null) {
        session.lastTurn = {
          startedAt: row.started_at,
          durationMs: row.duration_ms ?? 0,
          toolCount: row.tool_count ?? 0,
          failed: row.failed === 1,
          subtype: row.subtype ?? '',
          preview: row.preview ?? '',
        };
        if (row.error) session.lastTurn.error = row.error;
      }
      return session;
    });

    const total = Number(this.one<{ n: number }>(`SELECT COUNT(*) AS n ${fromWhere}`, params)?.n ?? 0);
    return { rows, total, offset, limit };
  }

  // --- logs ----------------------------------------------------------------

  appendLog(line: LogLine): void {
    if (this.closed) return;
    this.run('INSERT INTO logs (at, level, scope, message) VALUES (?, ?, ?, ?)', [
      line.at,
      line.level,
      line.scope,
      line.message,
    ]);
  }

  queryLogs(query: LogQuery = {}): LogRow[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (query.level) {
      where.push('level = ?');
      params.push(query.level);
    }
    if (query.scope) {
      where.push('scope = ?');
      params.push(query.scope);
    }
    if (query.search) {
      // LIKE is case-insensitive for ASCII in SQLite, which is what the log
      // pane wants. Escape the wildcards so a search for "100%" behaves.
      where.push(`message LIKE ? ESCAPE '\\'`);
      params.push(`%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (query.since !== undefined) {
      where.push('at >= ?');
      params.push(query.since);
    }
    if (query.before !== undefined) {
      where.push('id < ?');
      params.push(query.before);
    }
    const limit = Math.min(Math.max(query.limit ?? 500, 1), 5000);
    const sql = `SELECT * FROM logs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    params.push(limit);

    return this.all<LogDbRow>(sql, params).map((row) => ({
      id: row.id,
      at: row.at,
      level: row.level as LogRow['level'],
      scope: row.scope,
      message: row.message,
    }));
  }

  // --- lifecycle -----------------------------------------------------------

  prune(policy: RetentionPolicy = DEFAULT_RETENTION): void {
    if (this.closed) return;
    const now = Date.now();
    this.run('DELETE FROM logs WHERE at < ?', [now - policy.logDays * 86_400_000]);
    this.run('DELETE FROM turns WHERE started_at < ?', [now - policy.turnDays * 86_400_000]);
    // Then a hard ceiling on rows, so a very chatty day cannot outrun the age
    // sweep. The subquery is the id of the OLDEST row worth keeping; with fewer
    // rows than the ceiling it is NULL and the DELETE matches nothing.
    this.run('DELETE FROM logs WHERE id < (SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?)', [
      Math.max(1, policy.maxLogRows) - 1,
    ]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.exec('PRAGMA optimize');
    } catch (error) {
      log.debug('PRAGMA optimize failed', error);
    }
    this.statements.clear();
    this.db.close();
  }
}

/** Open (creating if needed) the state database inside `dir`. */
export function openStorage(dir: string): Storage {
  mkdirSync(dir, { recursive: true });
  return new SqliteStorage(join(dir, DB_FILENAME));
}

/**
 * One-time import of the old `.state/threads.json`.
 *
 * Idempotent by construction: a thread already in the database is never
 * overwritten, and `advanceCursor` is monotonic, so a second run is a no-op.
 *
 * Importing the CURSORS matters as much as the threads. Losing them re-seeds
 * every channel and re-runs a day of old turns, which is exactly the bug the
 * cursor logic exists to prevent. The JSON file is left alone afterwards.
 */
export function importLegacyState(storage: Storage, jsonPath: string, projects: ProjectConfig[]): LegacyImportReport {
  const sourcePath = resolve(jsonPath);
  const report: LegacyImportReport = { imported: false, sourcePath, threads: 0, cursors: 0, bound: 0, unbound: 0 };
  if (!existsSync(sourcePath)) return report;

  let snapshot: LegacyStoreSnapshot;
  try {
    const raw = JSON.parse(readFileSync(sourcePath, 'utf8')) as Partial<LegacyStoreSnapshot> & Record<string, unknown>;
    // v0.1 wrote threads at the top level. Read both shapes rather than lose them.
    snapshot = raw.threads
      ? { threads: raw.threads, cursors: raw.cursors ?? {} }
      : { threads: raw as unknown as Record<string, ThreadRecord>, cursors: {} };
  } catch (error) {
    log.warn(`could not read legacy state at ${sourcePath}`, error);
    return report;
  }

  const byDir = new Map<string, ProjectConfig>();
  for (const project of projects) byDir.set(resolve(project.dir), project);

  for (const [key, record] of Object.entries(snapshot.threads ?? {})) {
    const split = key.indexOf(':');
    if (split <= 0) continue;
    const channel = key.slice(0, split);
    const threadTs = key.slice(split + 1);
    if (storage.getThread(channel, threadTs)) continue;

    const match = record.cwd ? byDir.get(resolve(record.cwd)) : undefined;
    const now = new Date().toISOString();
    storage.putThread(channel, threadTs, {
      sessionId: record.sessionId ?? '',
      cwd: record.cwd ?? match?.dir ?? '',
      slackUserId: record.slackUserId ?? '',
      createdAt: record.createdAt ?? now,
      lastActiveAt: record.lastActiveAt ?? record.createdAt ?? now,
      turns: record.turns ?? 0,
      costUsd: record.costUsd ?? 0,
      projectId: match?.id ?? null,
      alias: match?.alias ?? null,
    });

    report.threads += 1;
    if (match) report.bound += 1;
    else report.unbound += 1;
  }

  for (const [channel, ts] of Object.entries(snapshot.cursors ?? {})) {
    if (!ts) continue;
    storage.advanceCursor(channel, ts);
    report.cursors += 1;
  }

  report.imported = report.threads > 0 || report.cursors > 0;
  if (report.imported) {
    log.info(
      `imported ${report.threads} thread(s) and ${report.cursors} cursor(s) from ${sourcePath} (${report.bound} bound by cwd)`,
    );
  }
  return report;
}

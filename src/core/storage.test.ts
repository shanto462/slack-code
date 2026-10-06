import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProjectConfig, Storage, ThreadRecord, TurnRow } from '../shared/contract.ts';
import { importLegacyState, openStorage } from './storage.ts';

function withStorage(body: (storage: Storage, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'slack-code-test-'));
  const storage = openStorage(dir);
  try {
    body(storage, dir);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function record(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    sessionId: 'sess-1',
    cwd: '/Users/me/project-a',
    slackUserId: 'U1',
    createdAt: '2026-08-20T00:01:54.689Z',
    lastActiveAt: '2026-08-20T00:02:05.837Z',
    turns: 1,
    costUsd: 0.34,
    projectId: 'prj_a',
    alias: 'writings',
    ...overrides,
  };
}

test('threads round trip, including the notified flags', () => {
  withStorage((storage) => {
    storage.putThread('D1', '100.1', record({ rejectedNotifiedAt: '2026-08-20T00:03:00.000Z' }));
    const loaded = storage.getThread('D1', '100.1');
    assert.ok(loaded);
    assert.equal(loaded.sessionId, 'sess-1');
    assert.equal(loaded.projectId, 'prj_a');
    assert.equal(loaded.alias, 'writings');
    assert.equal(loaded.turns, 1);
    assert.ok(Math.abs(loaded.costUsd - 0.34) < 1e-9);
    assert.equal(loaded.rejectedNotifiedAt, '2026-08-20T00:03:00.000Z');
    assert.equal(loaded.orphanNotifiedAt, undefined);
  });
});

test('patchThread merges, and an explicit null unbinds', () => {
  withStorage((storage) => {
    storage.putThread('D1', '100.1', record());
    storage.patchThread('D1', '100.1', { turns: 4, orphanNotifiedAt: '2026-08-20T01:00:00.000Z' });
    let loaded = storage.getThread('D1', '100.1')!;
    assert.equal(loaded.turns, 4);
    assert.equal(loaded.sessionId, 'sess-1', 'untouched fields survive');
    assert.equal(loaded.orphanNotifiedAt, '2026-08-20T01:00:00.000Z');

    storage.patchThread('D1', '100.1', { projectId: null, alias: null });
    loaded = storage.getThread('D1', '100.1')!;
    assert.equal(loaded.projectId, null);
    assert.equal(loaded.alias, null);

    // A key present with the value undefined CLEARS it. The service relies on
    // this to let a thread talk again once its project comes back.
    storage.patchThread('D1', '100.1', { orphanNotifiedAt: undefined });
    assert.equal(storage.getThread('D1', '100.1')?.orphanNotifiedAt, undefined);
    assert.equal(storage.getThread('D1', '100.1')?.turns, 4, 'absent keys are still untouched');

    storage.patchThread('D1', 'missing', { turns: 9 });
    assert.equal(storage.getThread('D1', 'missing'), undefined, 'patching an absent thread creates nothing');
  });
});

test('threadsFor filters by channel and last activity', () => {
  withStorage((storage) => {
    const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
    storage.putThread('D1', '1.1', record({ lastActiveAt: old }));
    storage.putThread('D1', '2.2', record({ lastActiveAt: new Date().toISOString() }));
    storage.putThread('D2', '3.3', record());

    assert.equal(storage.threadsFor('D1').length, 2);
    assert.equal(storage.threadsFor('D1', Date.now() - 86_400_000).length, 1);
    assert.equal(storage.threadsFor('D2').length, 1);
    assert.equal(storage.threadsForProject('prj_a').length, 3);
  });
});

test('the catch-up cursor is monotonic and compares numerically, not lexicographically', () => {
  withStorage((storage) => {
    assert.equal(storage.getCursor('D1'), undefined);

    storage.advanceCursor('D1', '1787184114.553889');
    assert.equal(storage.getCursor('D1'), '1787184114.553889');

    // Older ts: must not move.
    storage.advanceCursor('D1', '1787184000.000000');
    assert.equal(storage.getCursor('D1'), '1787184114.553889');

    // Lexicographically LARGER but numerically smaller. A string comparison
    // here would move the cursor backwards by nine hundred million seconds and
    // make the next restart replay a day of old turns under bypassPermissions.
    storage.advanceCursor('D1', '999999999.999999');
    assert.equal(storage.getCursor('D1'), '1787184114.553889');

    storage.advanceCursor('D1', '1787227368.271000');
    assert.equal(storage.getCursor('D1'), '1787227368.271000');
    assert.deepEqual(storage.allCursors(), { D1: '1787227368.271000' });
  });
});

test('turns are queryable and filterable', () => {
  withStorage((storage) => {
    const now = Date.now();
    // recordTurn drops a turn whose thread is gone, so the thread has to exist
    // first. That mirrors the service, which creates the record before it ever
    // enqueues, and it is why this is not just fixture ceremony.
    storage.putThread('D1', '1.1', record());
    const base = {
      channel: 'D1',
      threadTs: '1.1',
      projectId: 'prj_a',
      alias: 'writings',
      durationMs: 1200,
      toolCount: 3,
      preview: 'hi claude',
    };
    storage.recordTurn({ ...base, startedAt: now - 1000, endedAt: now, costUsd: 0.25, failed: false, subtype: 'success' });
    storage.recordTurn({
      ...base,
      projectId: 'prj_b',
      alias: 'slackcode',
      startedAt: now - 2000,
      endedAt: now,
      costUsd: 0.75,
      failed: true,
      subtype: 'error_during_execution',
      error: 'the tool crashed',
    });

    assert.equal(storage.recentTurns().length, 2);
    assert.equal(storage.recentTurns({ failedOnly: true }).length, 1);
    assert.equal(storage.recentTurns({ projectId: 'prj_a' })[0]?.costUsd, 0.25);
    assert.equal(storage.recentTurns({ failedOnly: true })[0]?.error, 'the tool crashed');
    assert.equal(storage.recentTurns({ failedOnly: true })[0]?.failed, true);
  });
});

function turn(overrides: Partial<Omit<TurnRow, 'id'>> = {}): Omit<TurnRow, 'id'> {
  return {
    channel: 'D1',
    threadTs: '1.1',
    projectId: 'prj_a',
    alias: 'writings',
    startedAt: 1_787_184_000_000,
    endedAt: 1_787_184_001_000,
    durationMs: 1000,
    toolCount: 0,
    costUsd: 0,
    failed: false,
    subtype: 'success',
    preview: 'hi claude',
    ...overrides,
  };
}

test('a turn that ends after its thread was removed is dropped, not orphaned', () => {
  withStorage((storage) => {
    storage.putThread('D1', '1.1', record());
    storage.recordTurn(turn());
    assert.equal(storage.deleteSession('D1', '1.1').turns, 1);

    // What a session still draining after a graceful stop does on its way out.
    // The service's busy check cannot see it, because a graceful close drops it
    // from the session map while the turn is still streaming.
    storage.recordTurn(turn({ preview: 'answered after the remove' }));

    assert.equal(storage.recentTurns({}).length, 0, 'no orphan turn row survives the remove');
    assert.equal(storage.sessions().total, 0, 'and the thread stays gone');
  });
});

test('sessions page newest first, and the total never drifts from the page', () => {
  withStorage((storage) => {
    const base = Date.parse('2026-08-20T00:00:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      storage.putThread('D1', `${i}.1`, record({ lastActiveAt: new Date(base + i * 60_000).toISOString() }));
    }

    const first = storage.sessions({ limit: 2 });
    assert.deepEqual(
      first.rows.map((row) => row.threadTs),
      ['4.1', '3.1'],
    );
    assert.equal(first.total, 5);
    assert.equal(first.offset, 0);
    assert.equal(first.limit, 2);
    assert.equal(first.rows[0]?.key, 'D1:4.1');
    // Epoch ms, not the ISO string ThreadRecord carries: the renderer's
    // relativeTime ticker reads epoch ms out of a data attribute.
    assert.equal(first.rows[0]?.lastActiveAt, base + 4 * 60_000);
    assert.equal(first.rows[0]?.createdAt, Date.parse('2026-08-20T00:01:54.689Z'));

    const second = storage.sessions({ limit: 2, offset: 2 });
    assert.deepEqual(
      second.rows.map((row) => row.threadTs),
      ['2.1', '1.1'],
    );
    // The count and the page come from one FROM+WHERE string. A second, hand
    // written WHERE for the count is exactly what this catches.
    assert.equal(second.total, 5);

    const last = storage.sessions({ limit: 2, offset: 4 });
    assert.equal(last.rows.length, 1, 'the final page is short');
    assert.equal(last.total, 5);

    assert.equal(storage.sessions().limit, 20, 'the default page size');
    assert.equal(storage.sessions({ since: base + 3 * 60_000 }).total, 2);
  });
});

test('a session carries its most recent turn, and none at all when it never ran one', () => {
  withStorage((storage) => {
    const now = Date.now();
    storage.putThread('D1', 'ran.1', record());
    storage.putThread('D1', 'never.1', record());
    storage.putThread('D1', 'tied.1', record());

    storage.recordTurn(turn({ threadTs: 'ran.1', startedAt: now - 3000, preview: 'oldest' }));
    storage.recordTurn(turn({ threadTs: 'ran.1', startedAt: now - 2000, preview: 'middle' }));
    storage.recordTurn(turn({ threadTs: 'ran.1', startedAt: now - 1000, preview: 'newest', toolCount: 7 }));

    // Same millisecond: ORDER BY started_at DESC, id DESC has to break the tie,
    // or which turn a row shows becomes luck.
    storage.recordTurn(turn({ threadTs: 'tied.1', startedAt: now, preview: 'first insert' }));
    storage.recordTurn(turn({ threadTs: 'tied.1', startedAt: now, preview: 'second insert' }));

    const byKey = new Map(storage.sessions().rows.map((row) => [row.key, row]));
    assert.equal(byKey.get('D1:ran.1')?.lastTurn?.preview, 'newest');
    assert.equal(byKey.get('D1:ran.1')?.lastTurn?.toolCount, 7);
    assert.equal(byKey.get('D1:ran.1')?.lastTurn?.startedAt, now - 1000);
    assert.equal(byKey.get('D1:tied.1')?.lastTurn?.preview, 'second insert');
    // A bound thread that has never run a turn is still a real session.
    assert.equal(byKey.get('D1:never.1')?.lastTurn, undefined);
    assert.equal(byKey.get('D1:never.1')?.cwd, '/Users/me/project-a');
  });
});

test('failedOnly means the LAST turn failed, and drops sessions with no turns', () => {
  withStorage((storage) => {
    const now = Date.now();
    storage.putThread('D1', 'recovered.1', record());
    storage.putThread('D1', 'broken.1', record());
    storage.putThread('D1', 'never.1', record());

    const failure = { failed: true, subtype: 'error_during_execution' };
    storage.recordTurn(turn({ threadTs: 'recovered.1', startedAt: now - 2000, ...failure, error: 'boom' }));
    storage.recordTurn(turn({ threadTs: 'recovered.1', startedAt: now - 1000 }));
    storage.recordTurn(turn({ threadTs: 'broken.1', startedAt: now - 1000, ...failure, error: 'still broken' }));

    const page = storage.sessions({ failedOnly: true });
    assert.deepEqual(
      page.rows.map((row) => row.threadTs),
      ['broken.1'],
      'a thread that recovered is not a failing session',
    );
    assert.equal(page.rows[0]?.lastTurn?.failed, true);
    assert.equal(page.rows[0]?.lastTurn?.error, 'still broken');
    // `u.failed = 1` is NULL for a turn-less session, so it drops out here but
    // is still one of the three sessions overall.
    assert.equal(page.total, 1);
    assert.equal(storage.sessions().total, 3);
  });
});

test('projectId filters sessions, and the total respects the filter', () => {
  withStorage((storage) => {
    storage.putThread('D1', '1.1', record({ projectId: 'prj_a' }));
    storage.putThread('D1', '2.2', record({ projectId: 'prj_b' }));
    storage.putThread('D1', '3.3', record({ projectId: 'prj_b' }));
    storage.putThread('D1', '4.4', record({ projectId: null, alias: null, sessionId: '' }));

    const page = storage.sessions({ projectId: 'prj_b', limit: 1 });
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0]?.projectId, 'prj_b');
    assert.equal(page.total, 2, 'not 4: the count carries the same WHERE as the page');
    assert.equal(storage.sessions({ projectId: 'prj_a' }).rows[0]?.alias, 'writings');
    assert.equal(storage.sessions().total, 4);

    const unbound = storage.sessions().rows.find((row) => row.threadTs === '4.4');
    assert.equal(unbound?.projectId, null);
    assert.equal(unbound?.sessionId, null, 'no session id until the first turn gives us one');
  });
});

test('deleteSession removes the thread and its turns, and says how many turns went', () => {
  withStorage((storage) => {
    storage.putThread('D1', 'doomed.1', record());
    storage.recordTurn(turn({ threadTs: 'doomed.1', preview: 'first' }));
    storage.recordTurn(turn({ threadTs: 'doomed.1', preview: 'second' }));

    assert.equal(storage.deleteSession('D1', 'doomed.1').turns, 2);
    assert.equal(storage.getThread('D1', 'doomed.1'), undefined);
    // Orphan turn rows would be invisible to every view in the app and would
    // only be collected 180 days later by prune(), so the DELETE has to reach
    // them in the same transaction.
    assert.equal(storage.recentTurns().length, 0);
    assert.equal(storage.sessions().total, 0);

    // A thread that is not there is not an error, and nothing was removed.
    assert.equal(storage.deleteSession('D1', 'doomed.1').turns, 0);
  });
});

test('deleteSession leaves other threads, and other threads turns, alone', () => {
  withStorage((storage) => {
    storage.putThread('D1', 'doomed.1', record());
    storage.putThread('D1', 'keeper.1', record());
    // Same thread_ts in a DIFFERENT channel: the key is the pair, not either half.
    storage.putThread('D2', 'doomed.1', record());

    storage.recordTurn(turn({ threadTs: 'doomed.1', preview: 'goes' }));
    storage.recordTurn(turn({ threadTs: 'keeper.1', preview: 'stays' }));
    storage.recordTurn(turn({ channel: 'D2', threadTs: 'doomed.1', preview: 'other channel stays' }));

    assert.equal(storage.deleteSession('D1', 'doomed.1').turns, 1);

    assert.ok(storage.getThread('D1', 'keeper.1'));
    assert.ok(storage.getThread('D2', 'doomed.1'));
    assert.deepEqual(
      storage
        .recentTurns()
        .map((row) => row.preview)
        .sort(),
      ['other channel stays', 'stays'],
    );
    assert.equal(storage.sessions().total, 2);
  });
});

test('deleteSession leaves the channel cursor intact', () => {
  withStorage((storage) => {
    storage.putThread('D1', 'doomed.1', record());
    storage.advanceCursor('D1', '1787227368.271000');

    storage.deleteSession('D1', 'doomed.1');

    // A cursor is per CHANNEL and outlives every thread in it. Dropping it here
    // would re-seed D1, so the next catch-up would replay a day of old DMs and
    // re-run those turns under bypassPermissions.
    assert.equal(storage.getCursor('D1'), '1787227368.271000');
    assert.deepEqual(storage.allCursors(), { D1: '1787227368.271000' });
  });
});

test('logs are searchable and prune enforces both limits', () => {
  withStorage((storage) => {
    const now = Date.now();
    storage.appendLog({ at: now, level: 'info', scope: 'service', message: 'socket mode connected' });
    storage.appendLog({ at: now, level: 'error', scope: 'session', message: 'turn failed badly' });
    storage.appendLog({ at: now - 30 * 86_400_000, level: 'info', scope: 'old', message: 'ancient history' });

    assert.equal(storage.queryLogs().length, 3);
    assert.equal(storage.queryLogs({ level: 'error' }).length, 1);
    assert.equal(storage.queryLogs({ search: 'SOCKET' }).length, 1, 'search is case insensitive');
    assert.equal(storage.queryLogs({ scope: 'session' })[0]?.message, 'turn failed badly');

    storage.prune({ logDays: 14, turnDays: 180, maxLogRows: 200_000 });
    assert.equal(storage.queryLogs().length, 2, 'the ancient line is gone');

    storage.prune({ logDays: 14, turnDays: 180, maxLogRows: 1 });
    const remaining = storage.queryLogs();
    assert.equal(remaining.length, 1, 'the row ceiling keeps only the newest');
    assert.equal(remaining[0]?.message, 'turn failed badly');
  });
});

test('the legacy JSON store imports its threads AND its cursors, binding by cwd', () => {
  withStorage((storage, dir) => {
    const jsonPath = join(dir, 'threads.json');
    writeFileSync(
      jsonPath,
      JSON.stringify({
        threads: {
          'D012ABC3DEF:1787184114.553889': {
            sessionId: 'a367441b-8686-4ac1-836f-b7b768e70964',
            cwd: '/Users/me/project-a',
            slackUserId: 'U012ABC3DEF',
            createdAt: '2026-08-20T00:01:54.689Z',
            lastActiveAt: '2026-08-20T00:02:05.837Z',
            turns: 1,
            costUsd: 0.34245299999999995,
          },
          'D012ABC3DEF:1787184397.443009': {
            sessionId: '86a8e1d6-c809-41a7-b96d-0e2306962cce',
            cwd: '/Users/me/project-b',
            slackUserId: 'U012ABC3DEF',
            createdAt: '2026-08-20T00:06:37.578Z',
            lastActiveAt: '2026-08-20T00:06:48.286Z',
            turns: 1,
            costUsd: 0.12,
          },
        },
        cursors: { D012ABC3DEF: '1787227368.271000' },
      }),
    );

    const projects: ProjectConfig[] = [
      {
        id: 'prj_a',
        alias: 'writings',
        aliases: [],
        name: 'Project A',
        dir: '/Users/me/project-a',
        enabled: true,
        createdAt: '2026-08-20T00:00:00.000Z',
      },
    ];

    const report = importLegacyState(storage, jsonPath, projects);
    assert.equal(report.imported, true);
    assert.equal(report.threads, 2);
    assert.equal(report.bound, 1);
    assert.equal(report.unbound, 1);
    assert.equal(report.cursors, 1);

    assert.equal(storage.getThread('D012ABC3DEF', '1787184114.553889')?.projectId, 'prj_a');
    assert.equal(storage.getThread('D012ABC3DEF', '1787184397.443009')?.projectId, null);
    // Losing the cursor is what makes a restart re-run a day of old turns.
    assert.equal(storage.getCursor('D012ABC3DEF'), '1787227368.271000');

    // Second run must change nothing: a live session id is never clobbered.
    storage.patchThread('D012ABC3DEF', '1787184114.553889', { sessionId: 'newer-session' });
    const again = importLegacyState(storage, jsonPath, projects);
    assert.equal(again.threads, 0);
    assert.equal(storage.getThread('D012ABC3DEF', '1787184114.553889')?.sessionId, 'newer-session');
  });
});

test('a missing legacy file is not an error', () => {
  withStorage((storage, dir) => {
    const report = importLegacyState(storage, join(dir, 'nope.json'), []);
    assert.equal(report.imported, false);
    assert.equal(report.threads, 0);
  });
});

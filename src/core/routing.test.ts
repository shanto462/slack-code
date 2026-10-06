import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_CONFIG,
  type ProjectConfig,
  type Route,
  type RouteInput,
  type StoredConfig,
  type ThreadRecord,
} from '../shared/contract.ts';
import { toRuntimeConfig, type RuntimeConfigInternal } from './config.ts';
import { route } from './routing.ts';

const NOW = 1_787_227_368_000;

function project(overrides: Partial<ProjectConfig> & { id: string; alias: string }): ProjectConfig {
  return {
    aliases: [],
    name: overrides.alias,
    dir: `/tmp/${overrides.alias}`,
    enabled: true,
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function build(projects: ProjectConfig[], routing: Partial<StoredConfig['routing']> = {}): RuntimeConfigInternal {
  return toRuntimeConfig({
    config: {
      ...DEFAULT_CONFIG,
      projects,
      routing: { ...DEFAULT_CONFIG.routing, ...routing },
      slack: { allowed: [{ entry: 'me', id: 'U1', name: 'me' }] },
    },
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    stateDir: '/tmp/state',
  });
}

function record(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    sessionId: 'sess-1',
    cwd: '/tmp/writings',
    slackUserId: 'U1',
    createdAt: new Date(NOW - 60_000).toISOString(),
    lastActiveAt: new Date(NOW - 1000).toISOString(),
    turns: 1,
    costUsd: 0.1,
    projectId: null,
    alias: null,
    ...overrides,
  };
}

function ask(text: string, input: Partial<RouteInput> = {}, config = build([project({ id: 'prj_a', alias: 'writings' })])): Route {
  return route({ text, record: undefined, isReply: false, now: NOW, ...input }, config);
}

const TWO = build([
  project({ id: 'prj_a', alias: 'writings', name: 'Writings', aliases: ['w'] }),
  project({ id: 'prj_b', alias: 'slackcode', name: 'slack-code' }),
]);

// --- R0 commands -----------------------------------------------------------

test('R0: !help works on a bound thread', () => {
  const result = ask('!help', { record: record({ projectId: 'prj_a', alias: 'writings' }) }, TWO);
  assert.equal(result.kind, 'command');
  if (result.kind === 'command') assert.equal(result.name, 'help');
});

test('R0: bare help runs on an unbound thread but is prose on a bound one', () => {
  assert.equal(ask('help', {}, TWO).kind, 'command');

  const bound = ask('help', { record: record({ projectId: 'prj_a', alias: 'writings' }) }, TWO);
  assert.equal(bound.kind, 'bound');
  if (bound.kind === 'bound') assert.equal(bound.prompt, 'help');
});

test('R0: bare cancel is not a command, only !cancel is', () => {
  assert.equal(ask('cancel', {}, TWO).kind, 'unknownAlias');
  const banged = ask('!cancel', { record: record({ projectId: 'prj_a', alias: 'writings' }) }, TWO);
  assert.equal(banged.kind, 'command');
  if (banged.kind === 'command') assert.equal(banged.name, 'cancel');
});

test('R0: command arguments carry the rest of the message', () => {
  const result = ask('!status now\nplease', { record: record({ projectId: 'prj_a' }) }, TWO);
  assert.equal(result.kind, 'command');
  if (result.kind === 'command') {
    assert.equal(result.name, 'status');
    assert.equal(result.args, 'now\nplease');
  }
});

// --- R1 bound --------------------------------------------------------------

test('R1: a bound thread never has its first line inspected or stripped', () => {
  // The first line here is a REAL alias for the other project, and it must be
  // treated as prose, not as routing.
  const text = 'slackcode\nis the thing I was asking about';
  const result = ask(text, { record: record({ projectId: 'prj_a', alias: 'writings' }), isReply: true }, TWO);
  assert.equal(result.kind, 'bound');
  if (result.kind === 'bound') {
    assert.equal(result.project.id, 'prj_a');
    assert.equal(result.prompt, text, 'the whole text is the prompt, alias line included');
  }
});

// --- R2 orphaned -----------------------------------------------------------

test('R2: a thread bound to a vanished project is told once, then ignored', () => {
  const orphan = record({ projectId: 'prj_gone', alias: 'gone' });
  const first = ask('carry on', { record: orphan, isReply: true }, TWO);
  assert.equal(first.kind, 'orphaned');
  if (first.kind === 'orphaned') assert.equal(first.alias, 'gone');

  const told = { ...orphan, orphanNotifiedAt: new Date(NOW - 5000).toISOString() };
  assert.equal(ask('and again', { record: told, isReply: true }, TWO).kind, 'ignore');
});

test('R2: a paused project orphans its live threads rather than rerouting them', () => {
  const config = build([project({ id: 'prj_a', alias: 'writings', enabled: false })]);
  const result = route(
    { text: 'hello', record: record({ projectId: 'prj_a', alias: 'writings' }), isReply: true, now: NOW },
    config,
  );
  assert.equal(result.kind, 'orphaned');
});

// --- R3 / R4 bind ----------------------------------------------------------

test('R3: alias on the first line binds and the alias line never reaches the model', () => {
  const result = ask('writings\nhi claude......\nsecond line', {}, TWO);
  assert.equal(result.kind, 'bind');
  if (result.kind === 'bind') {
    assert.equal(result.project.id, 'prj_a');
    assert.equal(result.alias, 'writings');
    assert.equal(result.prompt, 'hi claude......\nsecond line');
  }
});

test('R3: a secondary alias routes to the same project', () => {
  const result = ask('w\ndo the thing', {}, TWO);
  assert.equal(result.kind, 'bind');
  if (result.kind === 'bind') assert.equal(result.project.id, 'prj_a');
});

test('R4: alias alone binds and starts nothing', () => {
  const result = ask('writings', {}, TWO);
  assert.equal(result.kind, 'bindOnly');
  if (result.kind === 'bindOnly') assert.equal(result.alias, 'writings');
});

test('R4: an unbound REPLY of just the alias binds the thread, which is the R7 recovery path', () => {
  const result = ask('writings', { isReply: true, record: record({ rejectedNotifiedAt: new Date(NOW).toISOString() }) }, TWO);
  assert.equal(result.kind, 'bindOnly');
});

// --- alias normalisation ---------------------------------------------------

test('alias normalisation absorbs what mobile keyboards inject', () => {
  const variants = ['Writings', ' writings ', '/writings', '@writings', '#writings', 'writings:', 'writings.', ' writings​'];
  for (const variant of variants) {
    const result = ask(`${variant}\ngo`, {}, TWO);
    assert.equal(result.kind, 'bind', `expected ${JSON.stringify(variant)} to bind`);
    if (result.kind === 'bind') assert.equal(result.project.id, 'prj_a');
  }
});

// --- R5 paused -------------------------------------------------------------

test('R5: a paused alias gets its own message, not "unknown alias"', () => {
  const config = build([
    project({ id: 'prj_a', alias: 'writings' }),
    project({ id: 'prj_b', alias: 'archive', enabled: false }),
  ]);
  const result = route({ text: 'archive\ntidy up', record: undefined, isReply: false, now: NOW }, config);
  assert.equal(result.kind, 'paused');
  if (result.kind === 'paused') assert.equal(result.alias, 'archive');
});

// --- R6 fallback -----------------------------------------------------------

test('R6: singleProjectFallback preserves the old single-project behaviour, unstripped', () => {
  const one = build([project({ id: 'prj_a', alias: 'writings' })]);
  const result = route({ text: 'just do it\nnow', record: undefined, isReply: false, now: NOW }, one);
  assert.equal(result.kind, 'fallback');
  if (result.kind === 'fallback') {
    assert.equal(result.why, 'single');
    assert.equal(result.prompt, 'just do it\nnow');
  }
});

test('R6: with two projects and no default, there is no single fallback', () => {
  assert.equal(ask('just do it', {}, TWO).kind, 'unknownAlias');
});

test('R6: an explicit default project wins over everything else', () => {
  const config = build(
    [project({ id: 'prj_a', alias: 'writings' }), project({ id: 'prj_b', alias: 'slackcode' })],
    { defaultProjectId: 'prj_b' },
  );
  const result = route({ text: 'anything', record: undefined, isReply: false, now: NOW }, config);
  assert.equal(result.kind, 'fallback');
  if (result.kind === 'fallback') {
    assert.equal(result.why, 'default');
    assert.equal(result.project.id, 'prj_b');
  }
});

test('R6: a pending bind is consumed only by a live, top-level, unbound message', () => {
  const pendingBind = { projectId: 'prj_a', expiresAt: NOW + 60_000 };

  const consumed = ask('hi claude......', { pendingBind }, TWO);
  assert.equal(consumed.kind, 'fallback');
  if (consumed.kind === 'fallback') assert.equal(consumed.why, 'pending');

  assert.equal(ask('hi claude......', { pendingBind, isReply: true }, TWO).kind, 'unknownAlias');
  assert.equal(ask('hi claude......', { pendingBind: { projectId: 'prj_a', expiresAt: NOW - 1 } }, TWO).kind, 'unknownAlias');
  assert.equal(ask('hi claude......', { pendingBind: { projectId: 'prj_gone', expiresAt: NOW + 60_000 } }, TWO).kind, 'unknownAlias');
});

// --- R7 unknown alias ------------------------------------------------------

test('R7: an unknown alias reports what was seen and suggests the near miss', () => {
  const result = ask('writngs\nhi', {}, TWO);
  assert.equal(result.kind, 'unknownAlias');
  if (result.kind === 'unknownAlias') {
    assert.equal(result.seen, 'writngs');
    assert.equal(result.suggestion, 'writings');
    assert.equal(result.isReply, false);
  }
});

test('R7: a burst of the same bad alias produces one error, a different one is answered', () => {
  const told = record({ alias: 'writngs', rejectedNotifiedAt: new Date(NOW - 1000).toISOString() });
  assert.equal(ask('writngs\nagain', { record: told, isReply: true }, TWO).kind, 'ignore');
  assert.equal(ask('nonsense\nagain', { record: told, isReply: true }, TWO).kind, 'unknownAlias');

  const stale = record({ alias: 'writngs', rejectedNotifiedAt: new Date(NOW - 10 * 60_000).toISOString() });
  assert.equal(ask('writngs\nagain', { record: stale, isReply: true }, TWO).kind, 'unknownAlias');
});

test('an empty message is ignored rather than routed', () => {
  assert.equal(ask('   ', {}, TWO).kind, 'ignore');
});

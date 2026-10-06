import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG, TUNING_RANGES, type ProjectConfig } from '../shared/contract.ts';
import { normaliseConfig, resolveProject, toRuntimeConfig, validateConfig } from './config.ts';

function project(overrides: Partial<ProjectConfig> & { id: string; alias: string }): ProjectConfig {
  return {
    aliases: [],
    name: overrides.alias,
    dir: `/tmp/${overrides.alias}`,
    enabled: true,
    createdAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

test('normaliseConfig repairs nonsense instead of throwing', () => {
  const config = normaliseConfig({ agent: { permissionMode: 'wideOpen', effort: 'nuclear' }, projects: 'not an array' });
  assert.equal(config.schemaVersion, DEFAULT_CONFIG.schemaVersion);
  // A missing or unrecognised permission mode lands on the SAFER default, never
  // on bypassPermissions.
  assert.equal(config.agent.permissionMode, 'acceptEdits');
  assert.equal(config.agent.effort, DEFAULT_CONFIG.agent.effort);
  assert.deepEqual(config.projects, []);
  assert.equal(config.tuning.statusUpdateMs, DEFAULT_CONFIG.tuning.statusUpdateMs);
});

test('out-of-range tuning is clamped and reported, never rejected', () => {
  const raw = { tuning: { statusUpdateMs: 10, turnStallMinutes: 9999 } };
  const config = normaliseConfig(raw);
  assert.equal(config.tuning.statusUpdateMs, TUNING_RANGES.statusUpdateMs[0]);
  assert.equal(config.tuning.turnStallMinutes, TUNING_RANGES.turnStallMinutes[1]);

  const report = validateConfig(raw);
  assert.equal(report.clamped.length, 2);
  assert.ok(report.clamped.some((issue) => issue.field === 'tuning.statusUpdateMs'));
});

test('validation collects every problem at once, rather than stopping at the first', () => {
  const report = validateConfig({
    slack: { allowed: [] },
    agent: { permissionMode: 'nope' },
    projects: [
      { id: 'prj_a', alias: 'ok', dir: '/definitely/not/here' },
      { id: 'prj_b', alias: 'help', dir: '/definitely/not/here/either' },
    ],
  });

  assert.equal(report.ok, false);
  const fields = report.issues.map((issue) => issue.field);
  assert.ok(fields.includes('slack.allowed'));
  assert.ok(fields.includes('agent.permissionMode'));
  assert.ok(fields.includes('projects[0].dir'));
  assert.ok(fields.includes('projects[1].alias'), 'reserved aliases are rejected');
  assert.ok(report.issues.length >= 4, 'every problem is reported together');
});

test('a real directory and a resolvable operator validate clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-code-cfg-'));
  try {
    const report = validateConfig({
      slack: { allowed: [{ entry: 'me', id: 'U1' }] },
      projects: [{ id: 'prj_a', alias: 'writings', dir }],
    });
    assert.deepEqual(report.issues, []);
    assert.equal(report.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate aliases are caught, including across the secondary list', () => {
  const report = validateConfig({
    slack: { allowed: [{ entry: 'me', id: 'U1' }] },
    projects: [
      { id: 'prj_a', alias: 'writings', aliases: ['w'], dir: tmpdir() },
      { id: 'prj_b', alias: 'w', dir: tmpdir() },
    ],
  });
  assert.ok(report.issues.some((issue) => issue.message.includes('already used')));
});

test('resolveProject merges overrides over the defaults', () => {
  const defaults = { model: 'claude-opus-5', effort: 'max' as const, permissionMode: 'acceptEdits' as const };
  const plain = resolveProject(project({ id: 'prj_a', alias: 'writings' }), defaults);
  assert.equal(plain.model, 'claude-opus-5');
  assert.equal(plain.permissionMode, 'acceptEdits');

  const overridden = resolveProject(
    project({ id: 'prj_b', alias: 'risky', permissionMode: 'bypassPermissions', model: 'claude-sonnet-5' }),
    defaults,
  );
  assert.equal(overridden.permissionMode, 'bypassPermissions');
  assert.equal(overridden.model, 'claude-sonnet-5');
});

test('toRuntimeConfig indexes enabled projects by every alias, and pauses the rest separately', () => {
  const runtime = toRuntimeConfig({
    config: {
      ...DEFAULT_CONFIG,
      slack: { allowed: [{ entry: 'me', id: 'U1', name: 'me' }, { entry: 'nobody' }] },
      projects: [
        project({ id: 'prj_a', alias: 'writings', aliases: ['w', 'wr'] }),
        project({ id: 'prj_b', alias: 'archive', enabled: false }),
      ],
      routing: { ...DEFAULT_CONFIG.routing, defaultProjectId: 'prj_a' },
    },
    botToken: 'xoxb-1',
    appToken: 'xapp-1',
    stateDir: '/tmp/state',
    claudeExecutablePath: '/tmp/claude',
  });

  assert.equal(runtime.projects.length, 1, 'paused projects never reach the session layer');
  assert.equal(runtime.byAlias.get('w')?.id, 'prj_a');
  assert.equal(runtime.byAlias.get('wr')?.id, 'prj_a');
  assert.equal(runtime.byAlias.get('archive'), undefined);
  assert.equal(runtime.paused.get('archive')?.id, 'prj_b');
  assert.equal(runtime.pausedProjects.length, 1);
  assert.equal(runtime.defaultProject?.id, 'prj_a');
  assert.equal(runtime.claudeExecutablePath, '/tmp/claude');

  assert.deepEqual(runtime.allowedUserIds, ['U1'], 'only resolved entries become ids');
  assert.deepEqual(runtime.allowlistEntries, ['U1', 'nobody'], 'unresolved entries still get re-checked at start');
});

test('a default project that no longer exists is dropped, not carried', () => {
  const config = normaliseConfig({
    projects: [{ id: 'prj_a', alias: 'writings', dir: '/tmp/writings' }],
    routing: { defaultProjectId: 'prj_gone' },
  });
  assert.equal(config.routing.defaultProjectId, undefined);
});

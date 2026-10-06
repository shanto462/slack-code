import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResolvedProject } from '../shared/contract.ts';
import { echo, receiptFooter, unknownAliasMessage } from './messages.ts';

function project(alias: string, name = alias): ResolvedProject {
  return {
    id: `prj_${alias}`,
    alias,
    name,
    dir: `/tmp/${alias}`,
    model: 'claude-opus-5',
    permissionMode: 'acceptEdits',
    effort: 'max',
  };
}

test('an echo of operator text cannot break out of a code span', () => {
  assert.equal(echo('`rm -rf /`'), "'rm -rf /'");
  assert.equal(echo('a'.repeat(80)).length, 60);
  assert.equal(echo('two\nlines'), 'two lines');
});

test('the unknown-alias message shows the input, the aliases and a worked example', () => {
  const text = unknownAliasMessage('writngs', [project('writings', 'Writings'), project('slackcode', 'slack-code')], false, 'writings');
  assert.match(text, /writngs/);
  assert.match(text, /Did you mean `writings`\?/);
  assert.match(text, /• `writings`: Writings/);
  assert.match(text, /• `slackcode`: slack-code/);
  assert.match(text, /```\nwritings\n/, 'the example puts the alias on its own first line');
  assert.match(text, /Shift\+Enter/);
});

test('a reply gets the recovery instruction instead of the desktop hint', () => {
  const text = unknownAliasMessage('nonsense', [project('writings')], true);
  assert.match(text, /Reply with just `writings`/);
});

test('more than ten projects are capped with a count', () => {
  const many = Array.from({ length: 14 }, (_unused, index) => project(`p${index}`));
  const text = unknownAliasMessage('nope', many, false);
  assert.match(text, /_\+4 more, see the app\._/);
});

test('the receipt footer names the project, so an answer is self-identifying', () => {
  const footer = receiptFooter(project('writings', 'Writings'), {
    failed: false,
    durationMs: 12_400,
    costUsd: 0.08,
    toolCount: 3,
    numTurns: 1,
    subtype: 'success',
  });
  assert.equal(footer, '_Writings · 3 tool calls · 12.4s_');
});

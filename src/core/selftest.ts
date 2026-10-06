import {
  err,
  ok,
  type ResolvedProject,
  type Result,
  type SelfTestResult,
  type Storage,
  type TuningSettings,
} from '../shared/contract.ts';
import { logger } from './log.ts';
import { Session } from './session.ts';
import type { Slack } from './slack.ts';

const log = logger('selftest');

export interface SelfTestDeps {
  slack: Slack;
  storage: Storage;
  project: ResolvedProject;
  tuning: TuningSettings;
  /** The operator to DM. Normally the first resolved allowlist entry. */
  userId: string;
  claudeExecutablePath?: string;
  timeoutMs?: number;
}

const PROMPT =
  'This is an automated selftest of the Slack bridge. Reply with one short line confirming which directory you are running in and what today is. Do not use any tools.';

/**
 * Drive one full turn end to end without needing an inbound Slack event, so the
 * queue, the agent and the Slack posting path can be verified independently of
 * whether `message.im` is subscribed yet. That subscription is the one failure
 * the Slack API structurally cannot report.
 */
export async function runSelfTest(deps: SelfTestDeps): Promise<Result<SelfTestResult>> {
  const started = Date.now();
  const { slack, storage, project, tuning } = deps;

  let channel: string | undefined;
  let root = '';
  try {
    channel = await slack.openDm(deps.userId);
    if (!channel) return err('conversations.open returned no channel');
    root = await slack.postRaw(channel, undefined, `:test_tube: slack-code selftest against *${project.name}*`);
    if (!root) return err('could not post the selftest root message');
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }

  log.info(`selftest thread ${root} in ${channel}`);
  const now = new Date().toISOString();
  storage.putThread(channel, root, {
    sessionId: '',
    cwd: project.dir,
    slackUserId: deps.userId,
    createdAt: now,
    lastActiveAt: now,
    turns: 0,
    costUsd: 0,
    projectId: project.id,
    alias: project.alias,
  });

  const channelId = channel;
  return await new Promise<Result<SelfTestResult>>((resolve) => {
    let settled = false;
    const finish = (result: Result<SelfTestResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.close({ force: true });
      resolve(result);
    };

    const session = new Session({
      project,
      tuning,
      slack,
      storage,
      channel: channelId,
      threadTs: root,
      slackUserId: deps.userId,
      ...(deps.claudeExecutablePath ? { claudeExecutablePath: deps.claudeExecutablePath } : {}),
      onTurnEnd: (info) => {
        const result: SelfTestResult = {
          ok: !info.failed,
          projectId: project.id,
          channel: channelId,
          threadTs: root,
          durationMs: Date.now() - started,
          detail: info.failed ? `turn ended as ${info.subtype}` : `answered in ${Math.round(info.durationMs / 100) / 10}s`,
        };
        finish(result.ok ? ok(result) : err(result.detail));
      },
    });

    const timer = setTimeout(() => {
      log.error('selftest timed out');
      finish(err('selftest timed out waiting for a result'));
    }, deps.timeoutMs ?? 240_000);
    timer.unref();

    session.enqueue(PROMPT, root);
  });
}

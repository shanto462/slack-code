import {
  THREAD_COMMANDS,
  normaliseAlias,
  splitFirstLine,
  type ProjectConfig,
  type ResolvedProject,
  type Route,
  type RouteInput,
  type RuntimeConfig,
  type ThreadCommand,
} from '../shared/contract.ts';
import { pausedIndex } from './config.ts';

/**
 * The router. Pure: no Slack, no agent, no disk, and no clock beyond
 * `input.now`, which is what makes the whole routing table unit-testable.
 *
 * THE PERSISTED BINDING IS THE ONLY DISCRIMINATOR, never `event.thread_ts`.
 * Two concrete reasons in this codebase:
 *   1. `conversations.history` returns `thread_ts === ts` on any parent that
 *      has replies, so a replayed FIRST message would look like a reply.
 *   2. A genuine reply can arrive into a thread with no binding at all, which
 *      must not be mistaken for a bound thread.
 */

/**
 * How long an unknown-alias error stays suppressed on one thread for the SAME
 * alias. A burst of repeats produces one error, not three, while a different
 * alias always gets an answer so the operator is never left guessing.
 */
export const REJECT_QUIET_MS = 5 * 60_000;

export function route(input: RouteInput, config: RuntimeConfig): Route {
  const text = input.text.trim();
  if (!text) return { kind: 'ignore', why: 'empty message' };

  const record = input.record;
  const { head, body } = splitFirstLine(text);
  const boundProject = record?.projectId != null ? config.byId.get(record.projectId) : undefined;

  // R0 command. Works bound or unbound when prefixed with `!`. The bare form is
  // allowed only on an unbound thread, where the alternative is an
  // unknown-alias error anyway, so a bound thread's prose is never swallowed.
  const command = parseCommand(text, head, body, Boolean(boundProject));
  if (command) return { kind: 'command', name: command.name, args: command.args };

  // R1 bound. The ENTIRE text is the prompt: the first line is never inspected
  // and never stripped, so a reply whose first line happens to equal an alias
  // is just prose. Threads never change project either, because a resumed
  // session is pinned to the directory it was created in.
  if (boundProject) return { kind: 'bound', project: boundProject, prompt: text };

  // R2 orphaned. Bound once, but the project is gone or paused now. Say so
  // once, then stay quiet on this thread rather than silently rerouting it.
  if (record?.projectId != null) {
    if (record.orphanNotifiedAt) return { kind: 'ignore', why: 'orphaned thread already notified' };
    return { kind: 'orphaned', alias: record.alias };
  }

  const alias = normaliseAlias(head);

  // R3 / R4 bind. Exact map hit, never fuzzy.
  const project = alias ? config.byAlias.get(alias) : undefined;
  if (project) {
    // Alias alone: bind and acknowledge, start nothing. This is what makes
    // "open a thread on the phone, then dictate into it" work.
    return body ? { kind: 'bind', project, alias, prompt: body } : { kind: 'bindOnly', project, alias };
  }

  // R5 paused. A distinct message from an unknown alias, because the
  // operator's mental model ("I have that project") is correct.
  const paused: ProjectConfig | undefined = alias ? pausedIndex(config).get(alias) : undefined;
  if (paused) return { kind: 'paused', project: paused, alias };

  // R6 fallback. Here the first line IS a real prompt line, so the WHOLE text
  // is the prompt, unstripped.
  const fallback = resolveFallback(input, config);
  if (fallback) return { kind: 'fallback', project: fallback.project, prompt: text, why: fallback.why };

  // R7 unknown alias. Do not bind and do not spawn: the thread stays unbound so
  // the operator can reply with just the alias and R4 binds it.
  if (record?.rejectedNotifiedAt && record.alias === alias) {
    const told = Date.parse(record.rejectedNotifiedAt);
    if (Number.isFinite(told) && input.now - told < REJECT_QUIET_MS) {
      return { kind: 'ignore', why: 'unknown alias already reported on this thread' };
    }
  }

  const unknown: Route = { kind: 'unknownAlias', seen: head || text.slice(0, 60), isReply: input.isReply };
  const suggestion = suggestAlias(alias, config);
  return suggestion ? { ...unknown, suggestion } : unknown;
}

function resolveFallback(
  input: RouteInput,
  config: RuntimeConfig,
): { project: ResolvedProject; why: 'default' | 'single' | 'pending' } | null {
  if (config.defaultProject) return { project: config.defaultProject, why: 'default' };

  // Only when there is exactly one enabled project, where there is nothing to
  // confuse it with. This preserves the pre-Electron single-project behaviour.
  if (config.routing.singleProjectFallback && config.projects.length === 1) {
    return { project: config.projects[0]!, why: 'single' };
  }

  // The desktop Enter trap: Slack sends on Enter, so the alias and the prompt
  // often arrive as two separate TOP-LEVEL messages. The second one inherits
  // the binding the first one made, for a bounded window, once.
  const pending = input.pendingBind;
  if (pending && !input.isReply && pending.expiresAt > input.now) {
    const project = config.byId.get(pending.projectId);
    if (project) return { project, why: 'pending' };
  }

  return null;
}

function parseCommand(
  text: string,
  head: string,
  body: string,
  bound: boolean,
): { name: ThreadCommand; args: string } | null {
  const trimmed = head.trim();
  if (!trimmed) return null;

  const bang = trimmed.startsWith('!');
  const words = (bang ? trimmed.slice(1) : trimmed).trim().split(/\s+/);
  const token = normaliseAlias(words[0] ?? '');
  if (!token || !(THREAD_COMMANDS as readonly string[]).includes(token)) return null;

  // Bare `help` / `projects`, and only on an unbound thread.
  if (!bang && (bound || (token !== 'help' && token !== 'projects'))) return null;

  const args = [words.slice(1).join(' '), body].filter(Boolean).join('\n').trim();
  return { name: token as ThreadCommand, args };
}

/**
 * A near miss produces a SUGGESTION in the error text, never a silent route to
 * the wrong project. Anything further than two edits away is not a typo.
 */
export function suggestAlias(alias: string, config: RuntimeConfig): string | undefined {
  if (alias.length < 2) return undefined;
  let best: string | undefined;
  let bestDistance = 3;

  for (const candidate of config.byAlias.keys()) {
    // A prefix counts as a near miss only when the two are close in length.
    // Without that, a one-letter alias like `w` "matches" almost anything.
    if (Math.abs(candidate.length - alias.length) <= 2 && (candidate.startsWith(alias) || alias.startsWith(candidate))) {
      return candidate;
    }
    const distance = editDistance(alias, candidate, bestDistance);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** Levenshtein, abandoned as soon as every cell in a row exceeds `cap`. */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) >= cap) return cap;
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin >= cap) return cap;
    previous = current;
  }
  return previous[b.length]!;
}

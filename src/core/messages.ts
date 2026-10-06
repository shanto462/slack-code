import type { ProjectConfig, ResolvedProject, TurnEndInfo } from '../shared/contract.ts';
import { formatDuration } from './render.ts';

/**
 * Every operator-facing Slack string, in one file, in Slack mrkdwn (single
 * asterisks for bold, single underscores for italic).
 *
 * Two rules apply everywhere here:
 *   - anything the operator typed is truncated and has its backticks replaced,
 *     so an echo can never break out of a code span,
 *   - long project lists are capped, because a workspace with 40 projects
 *     should not produce a wall of text on a phone.
 */

const MAX_LISTED = 10;
const MAX_ECHO = 60;

/** Safe to put inside a backtick span: truncated, flattened, no backticks. */
export function echo(text: string, max = MAX_ECHO): string {
  const flat = text.replace(/`/g, "'").replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function aliasLine(project: ResolvedProject | ProjectConfig): string {
  const name = 'name' in project && project.name ? project.name : project.alias;
  return `• \`${project.alias}\`: ${name}`;
}

function listProjects(projects: (ResolvedProject | ProjectConfig)[]): string[] {
  const shown = projects.slice(0, MAX_LISTED).map(aliasLine);
  const hidden = projects.length - shown.length;
  if (hidden > 0) shown.push(`_+${hidden} more, see the app._`);
  return shown;
}

/**
 * The message that makes requirement 5 usable. It has to show what was typed,
 * every valid alias, and a worked example, because the operator is usually on a
 * phone and cannot go and read the config.
 */
export function unknownAliasMessage(
  seen: string,
  projects: ResolvedProject[],
  isReply: boolean,
  suggestion?: string,
): string {
  const lines: string[] = [];
  lines.push(`I could not match \`${echo(seen)}\` to a project.`);
  if (suggestion) lines.push(`Did you mean \`${suggestion}\`?`);
  lines.push('');

  if (projects.length === 0) {
    lines.push('No projects are configured yet. Open slack-code and add one, then try again.');
    return lines.join('\n');
  }

  lines.push('*Projects you can use*');
  lines.push(...listProjects(projects));
  lines.push('');

  const example = projects[0]!.alias;
  lines.push('Put the alias on its own first line, then the request:');
  lines.push('```');
  lines.push(example);
  lines.push('have a look at the failing test and fix it');
  lines.push('```');
  lines.push('');
  lines.push(
    isReply
      ? `This thread is not bound to a project yet. Reply with just \`${example}\` to bind it, then carry on normally.`
      : `Only the first message of a thread needs the alias. On desktop, Shift+Enter makes the line break (Enter sends), or send \`${example}\` on its own first and type the request after.`,
  );
  return lines.join('\n');
}

export function bindAckMessage(project: ResolvedProject): string {
  return [
    `Bound to *${project.name}* (\`${project.alias}\`) in \`${project.dir}\`.`,
    'Send the request now. Replies in this thread stay on this project, so you do not need the alias again.',
  ].join('\n');
}

export function pausedMessage(alias: string, others: ResolvedProject[]): string {
  const lines = [`*${echo(alias)}* is configured but paused, so I did not start anything.`, 'Enable it in slack-code, then send the message again.'];
  if (others.length > 0) {
    lines.push('');
    lines.push('*Running right now*');
    lines.push(...listProjects(others));
  }
  return lines.join('\n');
}

export function orphanedMessage(alias: string | null, others: ResolvedProject[]): string {
  const which = alias ? `*${echo(alias)}*` : 'the project it was bound to';
  const lines = [
    `This thread was bound to ${which}, which is no longer available, so nothing will run here.`,
    'Start a new thread with a valid alias on the first line. I will not say this again in this thread.',
  ];
  if (others.length > 0) {
    lines.push('');
    lines.push('*Available*');
    lines.push(...listProjects(others));
  }
  return lines.join('\n');
}

export function helpMessage(projects: ResolvedProject[]): string {
  const example = projects[0]?.alias ?? 'alias';
  return [
    '*slack-code*',
    'First line of the first message in a thread is the project alias. Everything after it is the request.',
    '```',
    example,
    'run the tests and tell me what broke',
    '```',
    'Replies in the same thread stay on that project, so the alias is only needed once.',
    '',
    '*Commands* (any line starting with `!`)',
    '• `!help`: this message',
    '• `!projects`: the project list',
    '• `!status`: what this thread is doing right now',
    '• `!cancel`: drop messages queued behind the running turn (the turn itself keeps going)',
    '',
    '*Good to know*',
    '• Messages sent while I am working are queued and delivered together at the start of the next turn, never mid-turn.',
    '• A turn that goes completely silent for too long is reset automatically. History survives, just send it again.',
  ].join('\n');
}

export function projectsMessage(projects: ResolvedProject[]): string {
  const lines: string[] = ['*Projects*'];
  if (projects.length === 0) lines.push('_none configured yet_');
  else lines.push(...listProjects(projects));
  return lines.join('\n');
}

/**
 * The footer under every answer. Naming the project makes each answer
 * self-identifying in a DM list that mixes several of them.
 */
export function receiptFooter(project: ResolvedProject, info: TurnEndInfo): string {
  const tools = `${info.toolCount} tool call${info.toolCount === 1 ? '' : 's'}`;
  return `_${project.name} · ${tools} · ${formatDuration(info.durationMs)}_`;
}

// --- the rest of the operator-facing surface -------------------------------

export function statusMessage(state: {
  projectName: string | null;
  busy: boolean;
  queued: number;
  activity?: string;
  turns: number;
  elapsedMs?: number;
}): string {
  const lines: string[] = [];
  lines.push(state.projectName ? `Thread is bound to *${state.projectName}*.` : 'This thread is not bound to a project yet.');
  if (state.busy) {
    const elapsed = state.elapsedMs ? ` for ${formatDuration(state.elapsedMs)}` : '';
    lines.push(`Working${elapsed}${state.activity ? `, currently: ${echo(state.activity, 80)}` : ''}.`);
  } else {
    lines.push('Idle, waiting for your next message.');
  }
  if (state.queued > 0) lines.push(`${state.queued} message${state.queued === 1 ? '' : 's'} queued behind the running turn.`);
  lines.push(`_${state.turns} turn${state.turns === 1 ? '' : 's'} so far_`);
  return lines.join('\n');
}

export function cancelMessage(dropped: number): string {
  if (dropped === 0) return 'Nothing was queued, so there was nothing to drop. The running turn keeps going.';
  return `Dropped ${dropped} queued message${dropped === 1 ? '' : 's'}. The running turn keeps going and will still answer.`;
}

export function filesIgnoredMessage(): string {
  return 'I can only read text right now, file uploads are ignored.';
}

export function stallMessage(silentFor: string): string {
  return `Reset this session: the turn produced no output for ${silentFor}, so it was almost certainly wedged. History is intact, just send your message again.`;
}

export function sessionErrorMessage(detail: string): string {
  return `Session error, the turn did not complete.\n\`\`\`\n${detail.slice(0, 1500)}\n\`\`\``;
}

export function turnFailedMessage(subtype: string): string {
  if (subtype === 'error_max_turns') return 'Stopped: the turn hit its maximum number of steps without finishing.';
  return `Turn ended without a result: \`${echo(subtype, 40)}\`.`;
}

export function missingDirMessage(project: ResolvedProject): string {
  return [
    `*${project.name}* points at \`${project.dir}\`, which I cannot read right now.`,
    'If the drive is unmounted or the folder moved, fix it in slack-code and send the message again.',
  ].join('\n');
}

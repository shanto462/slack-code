/**
 * Dashboard state.
 *
 * One small observable store, because five panes read the same status and
 * config and must never disagree about them. Everything here is plain data
 * cloned across IPC; nothing in this file talks to main directly.
 */

import { plural } from './format.ts';
import type {
  DaemonStatus,
  LogLine,
  RendererView,
  StoredConfig,
  TurnEvent,
} from '../../shared/contract.ts';

export type ProblemSeverity = 'warn' | 'bad';

/**
 * One line of the problems feed. `key` is a stable identity used to collapse a
 * repeat of the same fault into one row rather than a wall of duplicates.
 */
export interface Problem {
  key: string;
  at: number;
  severity: ProblemSeverity;
  title: string;
  detail?: string | undefined;
  hint?: string | undefined;
  /** Repeats collapsed into this row. */
  count: number;
}

export interface DashboardState {
  status: DaemonStatus | null;
  config: StoredConfig | null;
  /** Live incidents, newest first. Derived problems are merged in by `allProblems`. */
  incidents: Problem[];
  view: RendererView;
  /** Set while a start/stop/restart request is in flight, so the button can lock. */
  serviceBusy: boolean;
}

const MAX_INCIDENTS = 60;
/** A repeat of the same incident inside this window updates the existing row. */
const COLLAPSE_MS = 60_000;

export type Listener = (state: DashboardState) => void;

export class Store {
  private state: DashboardState = {
    status: null,
    config: null,
    incidents: [],
    view: 'dashboard',
    serviceBusy: false,
  };

  private listeners = new Set<Listener>();

  get(): DashboardState {
    return this.state;
  }

  patch(patch: Partial<DashboardState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  addIncident(problem: Omit<Problem, 'count'>): void {
    const existing = this.state.incidents[0];
    if (existing && existing.key === problem.key && problem.at - existing.at < COLLAPSE_MS) {
      const merged: Problem = { ...existing, ...problem, count: existing.count + 1 };
      this.state = { ...this.state, incidents: [merged, ...this.state.incidents.slice(1)] };
      this.emit();
      return;
    }
    const next = [{ ...problem, count: 1 }, ...this.state.incidents].slice(0, MAX_INCIDENTS);
    this.state = { ...this.state, incidents: next };
    this.emit();
  }

  clearIncidents(): void {
    this.patch({ incidents: [] });
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(this.state);
  }
}

// ---------------------------------------------------------------------------
// Turning raw events into problems
// ---------------------------------------------------------------------------

/** A turn event worth surfacing in the problems feed, or null for the routine ones. */
export function problemFromTurn(event: TurnEvent, aliasFor: (channel: string, threadTs: string) => string): Omit<Problem, 'count'> | null {
  if (event.type === 'turn:stalled') {
    const minutes = Math.round(event.silentMs / 60_000);
    return {
      key: `stall:${event.channel}:${event.threadTs}`,
      at: event.at,
      severity: 'warn',
      title: `Turn reset after ${minutes}m of silence`,
      detail: aliasFor(event.channel, event.threadTs),
      hint: 'The thread was going deaf, so the watchdog cleared it. Send the message again.',
    };
  }
  if (event.type === 'turn:ended' && event.info.failed) {
    return {
      key: `turnfail:${event.channel}:${event.threadTs}`,
      at: event.at,
      severity: 'bad',
      title: `Turn failed (${event.info.subtype})`,
      detail: aliasFor(event.channel, event.threadTs),
      hint: 'Open Logs and filter to errors for the reason.',
    };
  }
  return null;
}

/** Error-level log lines become problems; everything quieter stays in the log pane. */
export function problemFromLog(line: LogLine): Omit<Problem, 'count'> | null {
  if (line.level !== 'error') return null;
  return {
    key: `log:${line.scope}:${line.message.slice(0, 60)}`,
    at: line.at,
    severity: 'bad',
    title: line.scope,
    detail: line.message,
    hint: hintForLogMessage(line.message),
  };
}

function hintForLogMessage(message: string): string | undefined {
  const lower = message.toLowerCase();
  if (lower.includes('not logged in')) {
    return 'Claude Code could not read its Keychain credentials. Run the Claude auth check in Diagnostics.';
  }
  if (lower.includes('ratelimited') || lower.includes('rate limit')) {
    return 'Slack is throttling us. Raise the status update interval in Settings.';
  }
  if (lower.includes('command not found')) {
    return 'The agent shell has a crippled PATH. Check the shell PATH entry in Diagnostics.';
  }
  return undefined;
}

/**
 * Problems that are a property of the CURRENT state rather than of a past
 * event: they appear while the fault exists and vanish when it is fixed, with
 * no timer and no bookkeeping.
 */
export function derivedProblems(state: DashboardState): Omit<Problem, 'count'>[] {
  const status = state.status;
  if (!status) return [];
  const out: Omit<Problem, 'count'>[] = [];

  if (status.state === 'error') {
    out.push({
      key: 'svc:error',
      at: status.since,
      severity: 'bad',
      title: 'Service stopped with an error',
      detail: status.detail ?? 'No detail reported.',
      hint: 'Fix the reason below, then press Start.',
    });
  } else if (status.state === 'disconnected') {
    out.push({
      key: 'svc:disconnected',
      at: status.since,
      severity: 'bad',
      title: 'Disconnected from Slack',
      detail: status.detail,
      hint: 'Messages sent while disconnected are replayed by the catch-up sweep once the socket returns.',
    });
  } else if (status.state === 'reconnecting') {
    out.push({
      key: 'svc:reconnecting',
      at: status.since,
      severity: 'warn',
      title: 'Reconnecting to Slack',
      detail: status.detail,
    });
  }

  if (status.allowlist.unresolved.length > 0) {
    out.push({
      key: 'allowlist:unresolved',
      at: status.since,
      severity: 'warn',
      title: `${plural(status.allowlist.unresolved.length, 'operator entry', 'operator entries')} did not resolve`,
      detail: status.allowlist.unresolved.join(', '),
      hint: 'Open Settings and pick those people from the workspace list instead of typing them.',
    });
  }

  if (status.allowlist.resolved.length === 0) {
    out.push({
      key: 'allowlist:empty',
      at: status.since,
      severity: 'bad',
      title: 'No operators are allowed to drive the bot',
      detail: 'The service refuses to start until at least one Slack user resolves.',
      hint: 'Add yourself under Settings, Operators.',
    });
  }

  for (const project of status.projects) {
    // A paused project is not being routed to, so a broken directory under it
    // is not a live fault. The Projects pane still shows it in red.
    if (project.dirOk || !project.enabled) continue;
    out.push({
      key: `project:${project.id}`,
      at: status.since,
      severity: 'bad',
      title: `${project.name} cannot be reached`,
      detail: project.problem ?? project.dir,
      hint: 'Fix the path in Projects, or disable the project so routing reports it as paused.',
    });
  }

  if (!status.encryptionAvailable) {
    out.push({
      key: 'safestorage',
      at: status.since,
      severity: 'bad',
      title: 'Keychain encryption is unavailable',
      detail: 'Slack tokens cannot be written to disk, so the app is running from memory only.',
      hint: 'Tokens will have to be entered again after a restart.',
    });
  }

  if (status.projects.length === 0) {
    out.push({
      key: 'projects:none',
      at: status.since,
      severity: 'warn',
      title: 'No projects configured',
      detail: 'Every message will be answered with the unknown-alias error.',
      hint: 'Add one under Projects.',
    });
  }

  return out;
}

/** Derived problems first, then live incidents, both newest first. */
export function allProblems(state: DashboardState): Problem[] {
  const derived = derivedProblems(state).map((p) => ({ ...p, count: 1 }));
  return [...derived, ...state.incidents].sort((a, b) => b.at - a.at);
}

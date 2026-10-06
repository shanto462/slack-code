import { LOG_RING_CAPACITY, redactSecrets, type LogLevel, type LogLine } from '../shared/contract.ts';

/**
 * Debug used to be a module-level const read from the environment, which meant
 * the UI could never turn it on. It is a mutable flag now, flipped by
 * `setDebug()` from the settings pane.
 */
let debugEnabled = false;

/** One sink, owned by main, which fans lines into SQLite and the renderer. */
let sink: ((line: LogLine) => void) | null = null;

/** Bounded, so a window opening after a long run can backfill its log pane instantly. */
const ring: LogLine[] = [];

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isDebug(): boolean {
  return debugEnabled;
}

export function setLogSink(next: ((line: LogLine) => void) | null): void {
  sink = next;
}

/** Most recent lines, oldest first. */
export function logTail(limit = LOG_RING_CAPACITY): LogLine[] {
  if (limit >= ring.length) return ring.slice();
  return ring.slice(ring.length - limit);
}

export function clearLogTail(): void {
  ring.length = 0;
}

/** Flatten whatever was passed as the second argument into one printable string. */
function describe(extra: unknown): string {
  if (extra === undefined) return '';
  if (typeof extra === 'string') return extra;
  if (extra instanceof Error) {
    // Slack's WebClient hangs the API error code off `data`, and that code is
    // usually the only part worth reading.
    const code = (extra as { data?: { error?: string } }).data?.error;
    return code ? `${extra.message} (${code})` : extra.message;
  }
  const code = (extra as { data?: { error?: string } })?.data?.error;
  if (code) return code;
  try {
    return JSON.stringify(extra);
  } catch {
    return String(extra);
  }
}

function emit(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (level === 'debug' && !debugEnabled) return;

  const detail = describe(extra);
  // Redact once, here, so no downstream consumer can forget: the console, the
  // ring buffer and the sink all see the same already-safe text.
  const text = redactSecrets(detail ? `${message}: ${detail}` : message);
  const line: LogLine = { at: Date.now(), level, scope, message: text };

  ring.push(line);
  if (ring.length > LOG_RING_CAPACITY) ring.splice(0, ring.length - LOG_RING_CAPACITY);

  const stamp = new Date(line.at).toISOString().replace('T', ' ').slice(0, 19);
  const rendered = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${text}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(rendered);

  if (sink) {
    try {
      sink(line);
    } catch {
      // A broken sink must never take the app down, and must never recurse
      // back into the logger.
    }
  }
}

export function logger(scope: string) {
  return {
    info: (message: string, extra?: unknown) => emit('info', scope, message, extra),
    warn: (message: string, extra?: unknown) => emit('warn', scope, message, extra),
    error: (message: string, extra?: unknown) => emit('error', scope, message, extra),
    debug: (message: string, extra?: unknown) => emit('debug', scope, message, extra),
  };
}

export type Log = ReturnType<typeof logger>;

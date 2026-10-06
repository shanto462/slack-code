/**
 * Display formatting for the dashboard.
 *
 * `formatDuration` intentionally mirrors the version in src/core/render.ts byte
 * for byte in behaviour, so a turn shows the same numbers in the app as it does
 * in the Slack receipt footer. It is copied rather than imported because core is
 * compiled under the node tsconfig and the renderer under the web one; the
 * renderer must not pull core into its graph.
 */

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/** Wall-clock time, for log lines and turn rows. */
export function formatClock(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '--:--:--';
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDateTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return 'never';
  const d = new Date(at);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * "just now", "4m ago", "3h ago", then an absolute date. Rendered from a
 * `data-relative` attribute by a single ticking timer, so a table of live rows
 * never has to be rebuilt just to age its timestamps.
 */
export function formatRelative(at: number, now: number = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return 'never';
  const delta = Math.max(0, now - at);
  if (delta < 5_000) return 'just now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  const days = Math.floor(delta / 86_400_000);
  if (days < 7) return `${days}d ago`;
  return formatDateTime(at);
}

/** Running length of a turn, updated by the same ticker as `formatRelative`. */
export function formatElapsed(startedAt: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - startedAt);
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}:${pad(seconds)}`;
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

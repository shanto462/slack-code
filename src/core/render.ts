/** Slack hard-limits a text block at 3000 chars. Stay under it with room for wrappers. */
const CHUNK_LIMIT = 2800;

/** Unlikely to occur in real output, and survives the regex passes below intact. */
const SPAN_OPEN = '@@slackcode:';
const SPAN_CLOSE = ':edockcals@@';

/**
 * Convert the model's Markdown into Slack mrkdwn.
 *
 * The model is instructed to emit mrkdwn directly, but it slips into standard
 * Markdown often enough that an unconditional pass is worth it. Content inside
 * fenced code blocks is left byte-for-byte alone.
 */
export function toMrkdwn(input: string): string {
  const segments = input.split(/(```[\s\S]*?```)/g);
  return segments
    .map((segment) => (segment.startsWith('```') ? segment : convertProse(segment)))
    .join('');
}

function convertProse(text: string): string {
  // Park inline code spans so the transforms below cannot rewrite their contents.
  const spans: string[] = [];
  let out = text.replace(/`[^`\n]+`/g, (match) => {
    spans.push(match);
    return `${SPAN_OPEN}${spans.length - 1}${SPAN_CLOSE}`;
  });

  // [label](url) -> <url|label>. Runs before the bold pass so labels stay intact.
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');

  // ### Heading -> *Heading*
  out = out.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*$/gm, '*$1*');

  // **bold** -> *bold*, __bold__ -> *bold*
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  out = out.replace(/__([^_\n]+)__/g, '*$1*');

  // Markdown bullets -> a plain hyphen bullet Slack renders predictably.
  out = out.replace(/^(\s*)[*+]\s+/gm, '$1- ');

  // Horizontal rules render as noise in Slack.
  out = out.replace(/^\s*([-*_])\1{2,}\s*$/gm, '');

  // Collapse runs of blank lines.
  out = out.replace(/\n{3,}/g, '\n\n');

  // Restore the parked code spans.
  const restore = new RegExp(`${SPAN_OPEN}(\\d+)${SPAN_CLOSE}`, 'g');
  return out.replace(restore, (_match, index: string) => spans[Number(index)] ?? '');
}

/**
 * Split a message into Slack-sized chunks, preferring line boundaries and
 * never leaving a fenced code block unterminated across the split.
 */
export function chunk(text: string, limit = CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = '';
  let fenceOpen = false;

  for (const line of text.split('\n')) {
    const isFence = line.trimStart().startsWith('```');
    const candidate = current ? `${current}\n${line}` : line;

    if (candidate.length <= limit) {
      current = candidate;
      if (isFence) fenceOpen = !fenceOpen;
      continue;
    }

    if (current) {
      // Close the fence on the way out and reopen it on the way in, so both halves render.
      chunks.push(fenceOpen ? `${current}\n\`\`\`` : current);
      current = fenceOpen ? `\`\`\`\n${line}` : line;
    } else {
      // A single line longer than the limit: hard-split it.
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      current = '';
    }
    if (isFence) fenceOpen = !fenceOpen;
  }

  if (current) chunks.push(current);
  return chunks.filter((entry) => entry.trim().length > 0);
}

function short(value: unknown, max = 60): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

function basename(value: unknown): string {
  const path = typeof value === 'string' ? value : '';
  return path.split('/').filter(Boolean).pop() ?? short(path);
}

/** A compact one-line label for a tool call, for the live status message. */
export function toolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
      return `Read ${basename(input.file_path)}`;
    case 'Edit':
      return `Edit ${basename(input.file_path)}`;
    case 'Write':
      return `Write ${basename(input.file_path)}`;
    case 'NotebookEdit':
      return `Edit ${basename(input.notebook_path)}`;
    case 'Bash':
      return `$ ${short(input.command, 70)}`;
    case 'Grep':
      return `Grep ${short(input.pattern, 40)}`;
    case 'Glob':
      return `Glob ${short(input.pattern, 40)}`;
    case 'WebFetch':
      return `Fetch ${short(input.url, 50)}`;
    case 'WebSearch':
      return `Search ${short(input.query, 50)}`;
    case 'Task':
    case 'Agent':
      return `Subagent: ${short(input.description ?? input.prompt, 50)}`;
    case 'TodoWrite':
      return 'Updated plan';
    case 'Skill':
      return `Skill ${short(input.skill, 40)}`;
    default:
      return name;
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

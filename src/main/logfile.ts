/**
 * A plain text log on disk, next to the database copy.
 *
 * SQLite already holds the log for the in-app viewer, so this exists for the
 * two cases the database cannot cover: a failure early enough that storage is
 * not open yet, and an operator who wants to tail a file or attach one to a bug
 * report. It is capped and rotated so a machine that runs the app for a year
 * does not accumulate an unbounded file.
 */

import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import type { LogLine } from '../shared/contract.ts';
import { logFilePath } from './paths.ts';

const MAX_BYTES = 5 * 1024 * 1024;

let path: string | null = null;
let failed = false;

export function openLogFile(): void {
  try {
    path = logFilePath();
    rotateIfNeeded();
  } catch {
    // Losing the file log is survivable; the app keeps its in-memory ring and
    // the database copy.
    failed = true;
  }
}

function rotateIfNeeded(): void {
  if (!path || !existsSync(path)) return;
  if (statSync(path).size < MAX_BYTES) return;
  const previous = `${path}.1`;
  if (existsSync(previous)) unlinkSync(previous);
  renameSync(path, previous);
}

/** The line is already redacted: core's logger redacts once, at the source. */
export function appendLogFile(line: LogLine): void {
  if (failed || !path) return;
  try {
    const stamp = new Date(line.at).toISOString().replace('T', ' ').slice(0, 23);
    appendFileSync(path, `${stamp} ${line.level.toUpperCase().padEnd(5)} [${line.scope}] ${line.message}\n`, 'utf8');
    if (Math.random() < 0.01) rotateIfNeeded();
  } catch {
    // Stop trying after the first failure rather than throwing on every line.
    failed = true;
  }
}

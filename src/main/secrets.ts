/**
 * The two Slack tokens, and nothing else.
 *
 * Stored as `<userData>/secrets.json`, mode 0600, where each value is base64 of
 * safeStorage ciphertext. On macOS that ciphertext is bound to a Keychain entry
 * belonging to the app identity, so nothing outside this app can read it back.
 *
 * Rules this file follows, each of which has a reason:
 *
 *  - isEncryptionAvailable() is only ever called AFTER app.whenReady().
 *  - Decrypt ONCE at startup. Keychain calls block the calling thread, so
 *    decrypting per turn or per Slack event would stall the socket loop.
 *  - A failed decrypt can be a throw OR silent garbage, so the plaintext is
 *    validated against the known token prefixes before it is trusted.
 *  - An unsigned local build re-signs on every rebuild and the ciphertext stops
 *    decrypting, so "the stored blob is unreadable" is a routine path back into
 *    setup, not an exotic error.
 *  - There is NO plaintext fallback. If encryption is unavailable the app runs
 *    from in-memory tokens and refuses to persist. setUsePlainTextEncryption()
 *    is deliberately never called; it is a no-op on macOS anyway.
 *  - Plaintext never leaves the main process. `secretsStatus` returns presence
 *    and a redacted hint, and there is no IPC channel that reads a token back.
 */

import { safeStorage } from 'electron';
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { logger } from '../core/log.ts';
import { err, ok, tokenHint, type Result, type SecretsStatus, type StoredSecrets } from '../shared/contract.ts';
import { secretsPath } from './paths.ts';

const log = logger('secrets');

const SECRETS_SCHEMA_VERSION = 1;

export interface SecretBundle {
  botToken?: string;
  appToken?: string;
}

export const TOKEN_PREFIX = { botToken: 'xoxb-', appToken: 'xapp-' } as const;

export type SecretName = keyof typeof TOKEN_PREFIX;

/**
 * Safe to call before ready; reports false rather than throwing.
 *
 * Memoised, because this is read on every status push and Keychain calls block
 * the calling thread. Only a `true` is cached: a `false` can mean nothing worse
 * than "asked too early", and caching that would leave the app convinced for
 * the rest of the session that it cannot encrypt anything.
 */
let encryptionCache = false;

export function encryptionAvailable(): boolean {
  if (encryptionCache) return true;
  try {
    encryptionCache = safeStorage.isEncryptionAvailable();
    return encryptionCache;
  } catch (error) {
    log.debug('safeStorage.isEncryptionAvailable() failed', error);
    return false;
  }
}

function readFile(): StoredSecrets | null {
  const path = secretsPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredSecrets>;
    return {
      schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : SECRETS_SCHEMA_VERSION,
      ...(typeof parsed.slackBotToken === 'string' ? { slackBotToken: parsed.slackBotToken } : {}),
      ...(typeof parsed.slackAppToken === 'string' ? { slackAppToken: parsed.slackAppToken } : {}),
    };
  } catch (error) {
    log.warn('secrets.json could not be parsed, treating it as absent', error);
    return null;
  }
}

function writeFile(file: StoredSecrets): void {
  const path = secretsPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  // rename keeps the tmp file's mode, but an older file replaced in place might
  // not have had one, so assert it either way.
  chmodSync(path, 0o600);
}

/** Decrypt one stored value, rejecting anything that does not look like the right token. */
function decryptOne(name: SecretName, blob: string | undefined): string | undefined {
  if (!blob) return undefined;
  let plain: string;
  try {
    plain = safeStorage.decryptString(Buffer.from(blob, 'base64'));
  } catch (error) {
    log.warn(`stored ${name} could not be decrypted, clearing it`, error);
    return undefined;
  }
  if (!plain.startsWith(TOKEN_PREFIX[name])) {
    // Decryption can succeed and still return nonsense when the ciphertext was
    // written by a differently signed build of the app.
    log.warn(`stored ${name} decrypted to something that is not a ${TOKEN_PREFIX[name]} token, clearing it`);
    return undefined;
  }
  return plain;
}

/**
 * Read and decrypt both tokens. Call once during boot and hold the result.
 * Anything unreadable is dropped from disk here, so the app lands back in setup
 * rather than failing later with a confusing Slack auth error.
 */
export function loadSecrets(): SecretBundle {
  const file = readFile();
  if (!file) return {};

  if (!encryptionAvailable()) {
    log.warn('safeStorage is unavailable, so the stored tokens cannot be decrypted this run');
    return {};
  }

  const botToken = decryptOne('botToken', file.slackBotToken);
  const appToken = decryptOne('appToken', file.slackAppToken);

  const lostBot = file.slackBotToken !== undefined && botToken === undefined;
  const lostApp = file.slackAppToken !== undefined && appToken === undefined;
  if (lostBot || lostApp) {
    // Drop what cannot be read so the next launch does not retry the same
    // unreadable blob and warn all over again.
    const next: StoredSecrets = { schemaVersion: SECRETS_SCHEMA_VERSION };
    if (botToken) next.slackBotToken = file.slackBotToken;
    if (appToken) next.slackAppToken = file.slackAppToken;
    try {
      writeFile(next);
    } catch (error) {
      log.warn('could not rewrite secrets.json after dropping an unreadable token', error);
    }
  }

  return {
    ...(botToken ? { botToken } : {}),
    ...(appToken ? { appToken } : {}),
  };
}

/**
 * Encrypt and persist. `patch` carries only the tokens being changed; an empty
 * string clears one. Returns the full bundle so the caller can update the
 * in-memory copy it holds.
 */
export function saveSecrets(current: SecretBundle, patch: SecretBundle): Result<SecretBundle> {
  const next: SecretBundle = { ...current };

  for (const name of ['botToken', 'appToken'] as SecretName[]) {
    const value = patch[name];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (!trimmed) {
      delete next[name];
      continue;
    }
    if (!trimmed.startsWith(TOKEN_PREFIX[name])) {
      return err(
        name === 'botToken'
          ? 'The bot token should start with "xoxb-". That looks like the app-level token.'
          : 'The app token should start with "xapp-". That looks like the bot token.',
        'wrong_token_type',
      );
    }
    next[name] = trimmed;
  }

  if (!encryptionAvailable()) {
    // In-memory only. The caller can still run the service this session, but
    // nothing is written, because writing plaintext would be worse than not
    // remembering at all.
    return err(
      'Encrypted storage is unavailable on this machine, so the tokens cannot be saved. They will work until the app quits.',
      'no_encryption',
    );
  }

  try {
    const file: StoredSecrets = { schemaVersion: SECRETS_SCHEMA_VERSION };
    if (next.botToken) file.slackBotToken = safeStorage.encryptString(next.botToken).toString('base64');
    if (next.appToken) file.slackAppToken = safeStorage.encryptString(next.appToken).toString('base64');
    writeFile(file);
  } catch (error) {
    return err(`Could not write the encrypted tokens: ${error instanceof Error ? error.message : String(error)}`, 'write_failed');
  }

  log.info(`stored tokens updated (bot: ${next.botToken ? 'set' : 'unset'}, app: ${next.appToken ? 'set' : 'unset'})`);
  return ok(next);
}

export function clearStoredSecrets(): Result<null> {
  const path = secretsPath();
  try {
    if (existsSync(path)) unlinkSync(path);
    log.info('stored tokens cleared');
    return ok(null);
  } catch (error) {
    return err(`Could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function secretsStatus(bundle: SecretBundle): SecretsStatus {
  const available = encryptionAvailable();
  return {
    encryptionAvailable: available,
    writable: available,
    bot: bundle.botToken ? { present: true, hint: tokenHint(bundle.botToken) } : { present: false },
    app: bundle.appToken ? { present: true, hint: tokenHint(bundle.appToken) } : { present: false },
  };
}

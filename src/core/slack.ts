import { WebClient } from '@slack/web-api';
import type { AllowlistResolution, ResolvedUser, SlackIdentity, SlackWorkspaceUser } from '../shared/contract.ts';
import { logger } from './log.ts';
import { chunk, toMrkdwn } from './render.ts';

const log = logger('slack');

/**
 * The minimal inbound-message shape core needs. Socket Mode events and
 * `conversations.history` rows both narrow to this, so the live path and the
 * catch-up replay can share one handler.
 */
export interface SlackEventLike {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  files?: unknown[];
}

export class Slack {
  readonly web: WebClient;
  private botUserId: string | null = null;

  constructor(botToken: string) {
    this.web = new WebClient(botToken, { retryConfig: { retries: 3 } });
  }

  /**
   * Also latches the bot's own user id, which the self-message filter depends
   * on. A Slack instance must be rebuilt and this re-run whenever the bot token
   * changes: a stale instance would have a null self id, stop filtering its own
   * messages, and loop.
   */
  async whoAmI(): Promise<SlackIdentity> {
    const auth = await this.web.auth.test();
    this.botUserId = (auth.user_id as string) ?? null;
    return {
      botUserId: (auth.user_id as string) ?? '',
      botName: (auth.user as string) ?? '',
      teamId: (auth.team_id as string) ?? '',
      teamName: (auth.team as string) ?? '',
    };
  }

  get selfId(): string | null {
    return this.botUserId;
  }

  /** Every member of the workspace, paged. Feeds the wizard's user picker. */
  async listWorkspaceUsers(): Promise<SlackWorkspaceUser[]> {
    const users: SlackWorkspaceUser[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.web.users.list({ limit: 200, cursor });
      for (const member of page.members ?? []) {
        const id = member.id ?? '';
        if (!id) continue;
        users.push({
          id,
          name: member.name ?? '',
          realName: member.profile?.real_name ?? member.real_name ?? '',
          displayName: member.profile?.display_name ?? '',
          isBot: member.is_bot === true || id === 'USLACKBOT',
          deleted: member.deleted === true,
          avatar: member.profile?.image_48,
        });
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return users;
  }

  /**
   * Turn the allowlist (Slack usernames, display names, or raw Uxxxx ids) into
   * concrete user ids. Anything that cannot be resolved is reported rather than
   * silently dropped, because a typo here would lock the operator out.
   */
  async resolveUsers(entries: string[]): Promise<AllowlistResolution> {
    const wanted = entries.map((entry) => entry.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
    const direct = new Set(
      entries.filter((entry) => /^U[A-Z0-9]{6,}$/i.test(entry.trim())).map((entry) => entry.trim().toUpperCase()),
    );

    const resolved: ResolvedUser[] = [];
    const seen = new Set<string>();

    for (const member of await this.listWorkspaceUsers()) {
      const candidates = [
        member.id.toLowerCase(),
        member.name.toLowerCase(),
        member.displayName.toLowerCase(),
        member.realName.toLowerCase(),
      ].filter(Boolean);

      const matched = direct.has(member.id.toUpperCase()) || candidates.some((candidate) => wanted.includes(candidate));
      if (matched && !seen.has(member.id)) {
        seen.add(member.id);
        resolved.push({ id: member.id, name: member.name || member.displayName || member.id });
      }
    }

    const claimed = new Set<string>();
    for (const user of resolved) {
      claimed.add(user.id.toLowerCase());
      claimed.add(user.name.toLowerCase());
    }
    const unresolved = entries.filter((entry) => {
      const key = entry.trim().replace(/^@/, '');
      if (!key) return false;
      return !claimed.has(key.toLowerCase()) && !resolved.some((user) => user.id.toUpperCase() === key.toUpperCase());
    });

    return { resolved, unresolved };
  }

  /**
   * Post one logical message into a thread, split across as many Slack messages
   * as it needs. An optional footer is appended to the final piece only.
   * Returns the ts of the last piece.
   */
  async postToThread(channel: string, threadTs: string, text: string, footer?: string): Promise<string> {
    const pieces = chunk(toMrkdwn(text));
    if (pieces.length === 0) pieces.push('_(empty response)_');
    if (footer) pieces[pieces.length - 1] += `\n\n${footer}`;

    let last = '';
    for (const piece of pieces) {
      const response = await this.web.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: piece,
        mrkdwn: true,
        unfurl_links: false,
        unfurl_media: false,
      });
      last = (response.ts as string | undefined) ?? last;
    }
    return last;
  }

  async deleteMessage(channel: string, ts: string): Promise<void> {
    try {
      await this.web.chat.delete({ channel, ts });
    } catch (error) {
      log.debug('chat.delete failed (non-fatal)', error);
    }
  }

  /** Top-level messages in a channel newer than `oldest`, oldest-first. */
  async historySince(channel: string, oldest: string): Promise<SlackEventLike[]> {
    const response = await this.web.conversations.history({ channel, oldest, limit: 200, inclusive: false });
    return ((response.messages ?? []) as SlackEventLike[]).slice().reverse();
  }

  /** Replies in one thread newer than `oldest`, oldest-first, excluding the thread parent. */
  async repliesSince(channel: string, threadTs: string, oldest: string): Promise<SlackEventLike[]> {
    const response = await this.web.conversations.replies({ channel, ts: threadTs, oldest, limit: 200, inclusive: false });
    return ((response.messages ?? []) as SlackEventLike[]).filter((message) => message.ts !== threadTs);
  }

  /** The whole parent message of a thread, used to recover a lost binding. */
  async threadParent(channel: string, threadTs: string): Promise<SlackEventLike | undefined> {
    const response = await this.web.conversations.replies({ channel, ts: threadTs, limit: 1, inclusive: true });
    return ((response.messages ?? []) as SlackEventLike[])[0];
  }

  /** Open (or reopen) the DM channel with one user. */
  async openDm(userId: string): Promise<string | undefined> {
    const opened = await this.web.conversations.open({ users: userId });
    return (opened.channel as { id?: string } | undefined)?.id;
  }

  async postRaw(channel: string, threadTs: string | undefined, text: string): Promise<string> {
    const response = await this.web.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
    });
    return (response.ts as string | undefined) ?? '';
  }

  async update(channel: string, ts: string, text: string): Promise<void> {
    try {
      await this.web.chat.update({ channel, ts, text, ...{ mrkdwn: true } });
    } catch (error) {
      log.debug('chat.update failed (non-fatal)', error);
    }
  }

  async react(channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.web.reactions.add({ channel, timestamp: ts, name });
    } catch (error) {
      const message = (error as { data?: { error?: string } }).data?.error;
      if (message !== 'already_reacted') log.debug(`reactions.add ${name} failed`, message ?? error);
    }
  }

  async unreact(channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.web.reactions.remove({ channel, timestamp: ts, name });
    } catch (error) {
      const message = (error as { data?: { error?: string } }).data?.error;
      if (message !== 'no_reaction') log.debug(`reactions.remove ${name} failed`, message ?? error);
    }
  }
}

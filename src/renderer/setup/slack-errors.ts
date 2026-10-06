/**
 * Raw Slack error codes turned into something the operator can act on.
 *
 * The check functions in core already return a `hint`, and that hint wins
 * whenever it is present. This map is the safety net for the cases where a raw
 * `error` code from the Web API or from Socket Mode is all we have: "invalid_auth"
 * on its own tells an operator nothing, and the wrong guess costs a trip back to
 * api.slack.com.
 */

export interface SlackErrorExplanation {
  message: string;
  hint: string;
}

const EXPLANATIONS: Record<string, SlackErrorExplanation> = {
  invalid_auth: {
    message: 'Slack rejected that token.',
    hint: 'It was revoked, or it belongs to a different workspace. Reinstall the app and copy the Bot User OAuth Token again.',
  },
  not_authed: {
    message: 'No token reached Slack.',
    hint: 'The field looks empty once whitespace is stripped. Paste the token again.',
  },
  token_revoked: {
    message: 'That token has been revoked.',
    hint: 'Reinstall the Slack app to your workspace and copy the new Bot User OAuth Token.',
  },
  account_inactive: {
    message: 'The bot account is deactivated.',
    hint: 'Reinstall the app, or re-enable the bot user in the workspace.',
  },
  not_allowed_token_type: {
    message: 'That is the wrong kind of token.',
    hint: 'Socket Mode needs an app-level token. Generate one under Basic Information > App-Level Tokens with the connections:write scope. It starts with xapp-.',
  },
  missing_scope: {
    message: 'The token is valid but is missing a scope.',
    hint: 'Add the missing scope on the OAuth & Permissions page, then reinstall the app so the new scope takes effect.',
  },
  no_permission: {
    message: 'The token does not have permission for that call.',
    hint: 'Check the bot scopes against the manifest on the previous step, then reinstall the app.',
  },
  invalid_arguments: {
    message: 'Slack did not accept the request.',
    hint: 'Usually a malformed token. Copy it again straight from Slack without any surrounding quotes or spaces.',
  },
  ratelimited: {
    message: 'Slack rate limited this check.',
    hint: 'Wait about a minute and retry. Nothing is wrong with the token.',
  },
  team_access_not_granted: {
    message: 'The app is not installed in this workspace.',
    hint: 'Install the app to the workspace you want it to run in, then copy the token from that installation.',
  },
  fatal_error: {
    message: 'Slack returned a server error.',
    hint: 'This is on Slack, not on the token. Retry in a moment.',
  },
  connection_error: {
    message: 'Could not reach Slack.',
    hint: 'Check the network, then retry. A rejected token and an unreachable network look the same in the UI otherwise.',
  },
};

const NETWORK_MARKERS = ['fetch failed', 'enotfound', 'econnrefused', 'etimedout', 'econnreset', 'network', 'getaddrinfo'];

/**
 * Pull a known code out of arbitrary error text. Slack puts the code in the
 * `error` field, but by the time it reaches the renderer it is usually embedded
 * in a sentence, so match on the code as a whole word.
 */
export function explainSlackError(raw: string): SlackErrorExplanation | null {
  const text = raw.toLowerCase();

  if (NETWORK_MARKERS.some((marker) => text.includes(marker))) return EXPLANATIONS.connection_error ?? null;

  for (const [code, explanation] of Object.entries(EXPLANATIONS)) {
    if (new RegExp(`(^|[^a-z_])${code}([^a-z_]|$)`).test(text)) return explanation;
  }
  return null;
}

/** The hint to show under a failed check: the one core supplied, else a derived one. */
export function hintFor(detail: string, hint?: string): string | null {
  if (hint) return hint;
  return explainSlackError(detail)?.hint ?? null;
}

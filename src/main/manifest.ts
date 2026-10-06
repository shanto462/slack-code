/**
 * The Slack app manifest the wizard offers to copy.
 *
 * This is the highest-value screen in setup. A missing `message.im` subscription
 * is the one failure the Slack API cannot report back: everything verifies, the
 * bridge starts, and DMs simply never arrive. Handing the operator a manifest
 * that already contains the event and every scope makes that impossible to get
 * wrong, so the manifest is generated from the same constants the checks use
 * rather than being written out twice.
 */

import {
  SLACK_REQUIRED_APP_SCOPES,
  SLACK_REQUIRED_BOT_EVENTS,
  SLACK_REQUIRED_BOT_SCOPES,
} from '../shared/contract.ts';

export function slackAppManifest(appName = 'slack-code'): string {
  return [
    'display_information:',
    `  name: ${appName}`,
    '  description: Drive Claude Code sessions from Slack DMs.',
    '  background_color: "#1c1c1e"',
    'features:',
    '  bot_user:',
    `    display_name: ${appName}`,
    '    always_online: true',
    'oauth_config:',
    '  scopes:',
    '    bot:',
    ...SLACK_REQUIRED_BOT_SCOPES.map((scope) => `      - ${scope}`),
    'settings:',
    '  event_subscriptions:',
    '    bot_events:',
    ...SLACK_REQUIRED_BOT_EVENTS.map((event) => `      - ${event}`),
    '  interactivity:',
    '    is_enabled: false',
    '  org_deploy_enabled: false',
    '  socket_mode_enabled: true',
    '  token_rotation_enabled: false',
    '',
    '# After creating the app from this manifest:',
    '#  1. Install it to the workspace, then copy the Bot User OAuth Token (xoxb-).',
    `#  2. Basic Information > App-Level Tokens > generate one with ${SLACK_REQUIRED_APP_SCOPES.join(', ')} (xapp-).`,
    '',
  ].join('\n');
}

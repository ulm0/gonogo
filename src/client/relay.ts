import { RELAY_FORWARD_KINDS } from '../shared/protocol.js';
import type { RelayForwardKind, RelayLast, RelayService, UplinkKind } from '../shared/protocol.js';
import { atText } from './uplink.js';

// What Relay says and checks, kept out of RelayPanel.tsx so that it can be tested without a DOM. The steps are the exact ones of
// each service as they were when this was written; a word between backticks is shown as code.

export interface ServiceInfo {
  /** The kind of uplink that takes what the service sends. */
  kind: Exclude<UplinkKind, 'generic'>;
  label: string;
  /** The service gonogo posts to, or null for one that only sends (GitHub, Linear). */
  target: RelayService | null;
  /** The setup steps; a word between backticks is code. */
  steps: string[];
}

const ADDRESS = 'the address of the uplink (it is listed under the steps)';

export const SERVICES: readonly ServiceInfo[] = [
  {
    kind: 'github',
    label: 'GitHub',
    target: null,
    steps: [
      'Make the uplink below. Copy its secret now: it is shown once.',
      'In the repository (or the organization) open Settings, Webhooks, Add webhook.',
      `Payload URL: ${ADDRESS}. Content type: \`application/json\`. Secret: the secret you copied.`,
      'Choose "Let me select individual events" and tick Pushes, Pull requests, Issues, Issue comments and Workflow runs. Keep Active ticked and press Add webhook.',
      'GitHub sends a ping at once. Under Recent Deliveries a green tick means gonogo answered, and the uplink lists a delivery "answered".',
    ],
  },
  {
    kind: 'linear',
    label: 'Linear',
    target: null,
    steps: [
      'In Linear open Settings, API, Webhooks, New webhook.',
      'Label: gonogo. URL: `https://example.com` for now. Under Data change events tick Issues and Comments. Create the webhook.',
      'Copy the Signing secret that Linear shows.',
      'Make the uplink below and paste the signing secret into it.',
      `In Linear edit the webhook and put ${ADDRESS} in URL. Save.`,
      'Linear sends no ping: change an issue, and the uplink lists the delivery.',
    ],
  },
  {
    kind: 'slack',
    label: 'Slack',
    target: 'slack',
    steps: [
      'Open api.slack.com/apps, Create New App, From scratch. Pick a name and the workspace.',
      'OAuth & Permissions, Bot Token Scopes: add `chat:write`, `app_mentions:read`, `im:history` and `channels:history` (and `groups:history` for private channels).',
      'App Home: turn on the Messages Tab and tick "Allow users to send Slash commands and messages from the messages tab".',
      'Install App, Install to Workspace. Copy the Bot User OAuth Token, which starts with `xoxb-`.',
      'In Slack invite the bot to the channel (`/invite @name`) and copy the channel id (channel details, at the bottom of About). Save the token and the channel id as the target above and press Test.',
      'Basic Information, App Credentials: copy the Signing Secret. Make the uplink below and paste it into it.',
      `Event Subscriptions: switch it on and paste ${ADDRESS} as the Request URL. Slack checks it at once and shows Verified.`,
      'Under Subscribe to bot events add `app_mention`, `message.im` and `message.channels` (and `message.groups` for private channels). Save Changes, and reinstall the app if Slack asks.',
      'Mention the bot or write to it, and the agent gets the message. Reply in the thread of a message gonogo posted to answer the agent that wrote it.',
    ],
  },
  {
    kind: 'telegram',
    label: 'Telegram',
    target: 'telegram',
    steps: [
      'In Telegram write to @BotFather: `/newbot`, and pick a name. Copy the bot token, which looks like `123456789:AAF…`.',
      'Write any message to your new bot. Open `https://api.telegram.org/bot<BOT TOKEN>/getUpdates` in a browser and copy the number that follows `"chat":{"id":`. It is the chat id.',
      'Save the bot token and the chat id as the target above and press Test. Only this chat can talk to your agents: a message from any other chat is dropped.',
      'Make the uplink below. Copy its secret now: it is shown once.',
      `Tell Telegram where to send what you write. In a terminal: \`curl "https://api.telegram.org/bot<BOT TOKEN>/setWebhook" --data-urlencode "url=<ADDRESS>" --data-urlencode "secret_token=<SECRET>"\`. The address of the uplink must be HTTPS on port 443, 80, 88 or 8443. The answer says \`"ok":true\`.`,
      'Write to the bot, and the agent gets the message. Reply to a message the bot sent to answer the agent that wrote it.',
    ],
  },
];

export const FORWARD_LABELS: Record<RelayForwardKind, string> = {
  message: 'Messages to you',
  redline: 'Redline trips',
  tminus: 'T-minus results',
  'flight-plan': 'Tasks blocked or in review',
};

/** The kinds that are forwarded after one is switched on or off, in the order of the list. */
export const toggled = (kinds: readonly RelayForwardKind[], kind: RelayForwardKind, on: boolean): RelayForwardKind[] =>
  RELAY_FORWARD_KINDS.filter((k) => (k === kind ? on : kinds.includes(k)));

/** How the last send went, for the line under a target. */
export const lastText = (last: RelayLast | null, now: number): string => (last === null ? 'Nothing sent yet' : `Last send ${atText(last.at, now)}: ${last.note}`);

export const TARGET_FIELDS: Record<RelayService, { to: string; hint: string }> = {
  slack: { to: 'Channel id', hint: 'The id of the channel, such as C0123456789. The bot must be in it.' },
  telegram: { to: 'Chat id', hint: 'The number of your chat with the bot. A group has a negative number.' },
};

export interface TargetValues {
  token: string;
  to: string;
}
export type TargetProblems = Partial<Record<keyof TargetValues, string>>;

/** A token is needed the first time; after that an empty one means "keep the saved one". The server checks the shape. */
export function targetProblems(values: TargetValues, saved: boolean): TargetProblems {
  const problems: TargetProblems = {};
  if (values.token.trim() === '' && !saved) problems.token = 'Paste the bot token.';
  if (values.to.trim() === '') problems.to = 'Say where to post.';
  return problems;
}

/** The text split on backticks: what is between them is code. */
export function parts(text: string): Array<{ code: boolean; text: string }> {
  return text.split('`').map((piece, i) => ({ code: i % 2 === 1, text: piece })).filter((p) => p.text !== '');
}

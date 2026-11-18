/**
 * Relay, inbound: the uplink kinds of GitHub, Linear, Slack and Telegram (docs/relay-spec.md). Each kind has the two functions
 * that uplinks.ts asks of a kind: `authentic` (the proof of the service, compared in constant time) and `read` (what the body
 * means). Nothing here touches the network, the files or the clock: a test feeds bodies and headers in.
 *
 * shortcut: GitHub, Linear and Telegram signatures carry no time, so a captured request can be sent again. Slack's carry one
 * (SLACK_SIGNATURE_MAX_AGE_MS). Add a check of Linear's `webhookTimestamp` if a replay ever matters.
 * shortcut: a Slack user is its id (`U123`), a channel its id: names need an API call and a token with more scopes.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { UplinkKind } from '../shared/protocol.js';
import { SLACK_SIGNATURE_MAX_AGE_MS } from './constants.js';
import { isRecord } from './hooks.js';
import { cutText, HubError } from './hub.js';
import type { Inbound, KindDef, Made } from './uplinks.js';

const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
/** Equal text, in constant time (both are hashed first, so that the lengths match). */
const same = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));
const hmacHex = (secret: string, ...parts: Array<string | Buffer>): string => parts.reduce((h, part) => h.update(part), createHmac('sha256', secret)).digest('hex');

const header = (headers: IncomingHttpHeaders, name: string): string | null => {
  const value = headers[name];
  return typeof value === 'string' ? value : null;
};
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const get = (value: unknown, path: string): unknown => path.split('.').reduce<unknown>((at, key) => (isRecord(at) ? at[key] : undefined), value);
/** One line of at most `max` characters; the text comes from strangers (a title, a commit) and must not break the layout. */
const line = (value: unknown, max = 200): string => cutText(str(value).replace(/\s+/g, ' ').trim(), max);
/** A few lines of the text of an issue or a comment, with a mark where it was cut. */
const excerpt = (value: unknown, max = 1000): string => {
  const text = str(value).trim();
  return text.length > max ? `${cutText(text, max)}…` : text;
};
const lines = (...parts: Array<string | false | null | undefined>): string => parts.filter((part): part is string => typeof part === 'string' && part !== '').join('\n');
const text = (message: string, extra: Partial<Extract<Made, { text: string }>> = {}): Made => ({ text: message, cut: false, ...extra });

function parse(raw: Buffer): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HubError('bad_request', 'the body is not JSON');
  }
  if (!isRecord(body)) throw new HubError('bad_request', 'the body is not a JSON object');
  return body;
}

/* ---------------------------------------------------------------- GitHub */

/** `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body, keyed with the secret>`. */
const githubAuthentic = (raw: Buffer, headers: IncomingHttpHeaders, secret: string): boolean => {
  const given = header(headers, 'x-hub-signature-256');
  return given !== null && same(given, `sha256=${hmacHex(secret, raw)}`);
};

function githubRead(raw: Buffer, headers: IncomingHttpHeaders): Made {
  const event = header(headers, 'x-github-event');
  const body = parse(raw);
  const repo = line(get(body, 'repository.full_name'));
  const who = line(get(body, 'sender.login'));
  const action = line(body.action, 40);
  const number = line(get(body, 'issue.number') ?? get(body, 'pull_request.number'), 20);
  switch (event) {
    case 'ping':
      return { answer: { ok: true, ping: true }, note: `ping${repo === '' ? '' : ` from ${repo}`}` };
    case 'push': {
      const commits = Array.isArray(body.commits) ? body.commits : [];
      const listed = commits.slice(0, 5).map((c) => `- ${line(get(c, 'id'), 7)} ${line(str(get(c, 'message')).split('\n')[0], 120)}`);
      const flags = `${body.forced === true ? ' (forced)' : ''}${body.deleted === true ? ' (deleted)' : ''}`;
      return text(
        lines(
          `GitHub push to ${repo} ${line(body.ref)} by ${line(get(body, 'pusher.name')) || who}: ${commits.length} commit${commits.length === 1 ? '' : 's'}${flags}`,
          ...listed,
          commits.length > 5 && `- and ${commits.length - 5} more`,
          line(body.compare, 300),
        ),
      );
    }
    case 'pull_request': {
      const pr = get(body, 'pull_request');
      const done = action === 'closed' && get(pr, 'merged') === true ? 'merged' : action;
      return text(
        lines(
          `GitHub pull request #${number} ${done} by ${who} in ${repo}: ${line(get(pr, 'title'))}`,
          `${line(get(pr, 'head.ref'), 100)} into ${line(get(pr, 'base.ref'), 100)}`,
          line(get(pr, 'html_url'), 300),
          excerpt(get(pr, 'body')) && `\n${excerpt(get(pr, 'body'))}`,
        ),
      );
    }
    case 'issues':
      return text(
        lines(`GitHub issue #${number} ${action} by ${who} in ${repo}: ${line(get(body, 'issue.title'))}`, line(get(body, 'issue.html_url'), 300), excerpt(get(body, 'issue.body')) && `\n${excerpt(get(body, 'issue.body'))}`),
      );
    case 'issue_comment': {
      const on = get(body, 'issue.pull_request') === undefined ? 'issue' : 'pull request';
      return text(
        lines(`GitHub comment ${action} by ${who} on ${on} #${number} in ${repo}: ${line(get(body, 'issue.title'))}`, line(get(body, 'comment.html_url'), 300), excerpt(get(body, 'comment.body')) && `\n${excerpt(get(body, 'comment.body'))}`),
      );
    }
    case 'workflow_run': {
      // requested and in_progress are two more messages for each run that tells nothing the last one does not
      if (action !== 'completed') return null;
      const run = get(body, 'workflow_run');
      return text(lines(`GitHub workflow "${line(get(run, 'name'), 100)}" run #${line(get(run, 'run_number'), 20)} ${line(get(run, 'conclusion'), 40)} on ${line(get(run, 'head_branch'), 100)} in ${repo}`, line(get(run, 'html_url'), 300)));
    }
    default:
      return null;
  }
}

/* ---------------------------------------------------------------- Linear */

/** `Linear-Signature: <hex HMAC-SHA256 of the raw body, keyed with the signing secret>`. */
const linearAuthentic = (raw: Buffer, headers: IncomingHttpHeaders, secret: string): boolean => {
  const given = header(headers, 'linear-signature');
  return given !== null && same(given.toLowerCase(), hmacHex(secret, raw));
};

const PAST: Record<string, string> = { create: 'created', update: 'updated', remove: 'removed' };

function linearRead(raw: Buffer): Made {
  const body = parse(raw);
  const data = body.data;
  const type = str(body.type);
  const did = PAST[str(body.action)] ?? line(body.action, 40);
  const actor = line(get(body, 'actor.name')) || line(get(data, 'user.name'));
  const by = actor === '' ? '' : ` by ${actor}`;
  const url = line(body.url, 300);
  if (type === 'Issue') {
    const key = line(get(data, 'identifier')) || [line(get(data, 'team.key'), 20), line(get(data, 'number'), 20)].filter(Boolean).join('-');
    const changed = isRecord(body.updatedFrom) ? Object.keys(body.updatedFrom).slice(0, 8).join(', ') : '';
    const state = line(get(data, 'state.name'), 60);
    const assignee = line(get(data, 'assignee.name'), 60);
    return text(
      lines(
        `Linear issue ${key} ${did}${by}: ${line(get(data, 'title'))}`,
        [state && `state ${state}`, assignee && `assigned to ${assignee}`, line(get(data, 'priorityLabel'), 30) && `priority ${line(get(data, 'priorityLabel'), 30)}`, changed && `changed: ${changed}`].filter(Boolean).join(', '),
        url,
        excerpt(get(data, 'description')) && `\n${excerpt(get(data, 'description'))}`,
      ),
    );
  }
  if (type === 'Comment') {
    return text(lines(`Linear comment ${did}${by} on ${line(get(data, 'issue.title'))}`, url, excerpt(get(data, 'body')) && `\n${excerpt(get(data, 'body'))}`));
  }
  return null;
}

/* ---------------------------------------------------------------- Slack */

/** `X-Slack-Signature: v0=<hex HMAC-SHA256 of "v0:<timestamp>:<raw body>", keyed with the signing secret>`; the timestamp (seconds) is at most five minutes old. */
const slackAuthentic = (raw: Buffer, headers: IncomingHttpHeaders, secret: string, now: number): boolean => {
  const given = header(headers, 'x-slack-signature');
  const stamp = header(headers, 'x-slack-request-timestamp');
  if (given === null || stamp === null || !/^\d{1,12}$/.test(stamp)) return false;
  if (Math.abs(now - Number(stamp) * 1000) > SLACK_SIGNATURE_MAX_AGE_MS) return false;
  return same(given, `v0=${hmacHex(secret, `v0:${stamp}:`, raw)}`);
};

function slackRead(raw: Buffer, _headers: IncomingHttpHeaders, inbound: Inbound): Made {
  const body = parse(raw);
  if (body.type === 'url_verification') {
    if (typeof body.challenge !== 'string') throw new HubError('bad_request', 'the challenge is missing');
    return { answer: { challenge: body.challenge }, note: 'challenge answered' };
  }
  const event = body.event;
  if (body.type !== 'event_callback' || !isRecord(event)) return null;
  const channel = str(event.channel);
  const ts = str(event.ts);
  const user = str(event.user);
  const said = str(event.text).trim();
  // a bot (this one too: what gonogo posts comes back as an event) and a message with a subtype (edits, joins) are not the Director
  if (channel === '' || ts === '' || user === '' || said === '' || event.bot_id !== undefined || event.subtype !== undefined) return null;
  const mention = event.type === 'app_mention';
  const direct = event.type === 'message' && event.channel_type === 'im';
  const thread = str(event.thread_ts);
  const parent = thread !== '' && thread !== ts ? inbound.find(`slack:${channel}:${thread}`) : undefined;
  // in a channel only a reply to something gonogo posted counts: the rest of what is said there is not for the agents
  if (!mention && !direct && !(event.type === 'message' && parent !== undefined)) return null;
  const once = `slack:${channel}:${ts}`;
  if (parent !== undefined) return text(excerpt(said, 4000), { to: parent.agent, inReplyTo: parent.id, subject: `Re: ${parent.subject}`.slice(0, 200), once });
  return text(`Slack ${mention ? 'mention' : 'direct message'} from ${user} in ${channel}:\n\n${excerpt(said, 4000)}`, { once });
}

/* ---------------------------------------------------------------- Telegram */

/** `X-Telegram-Bot-Api-Secret-Token` is the `secret_token` given to setWebhook, as it is. */
const telegramAuthentic = (_raw: Buffer, headers: IncomingHttpHeaders, secret: string): boolean => {
  const given = header(headers, 'x-telegram-bot-api-secret-token');
  return given !== null && same(given, secret);
};

function telegramRead(raw: Buffer, _headers: IncomingHttpHeaders, inbound: Inbound): Made {
  const update = parse(raw);
  // a button of phone approvals: only from the chat of the target, and what it means is for phone.ts to check (the tag)
  const query = update.callback_query;
  if (isRecord(query)) {
    const chat = str(get(query, 'message.chat.id'));
    const queryId = str(query.id);
    if (chat === '' || chat !== inbound.telegramChat() || queryId === '' || typeof query.data !== 'string') return null;
    return { callback: { queryId, data: query.data, chat, messageId: str(get(query, 'message.message_id')) } };
  }
  const message = update.message;
  const said = str(get(message, 'text')).trim();
  const chat = str(get(message, 'chat.id'));
  // a bot can be found and written to by anybody on Telegram: only the chat of the target is the Director
  if (said === '' || chat === '' || chat !== inbound.telegramChat()) return null;
  const parent = inbound.find(`telegram:${chat}:${str(get(message, 'reply_to_message.message_id'))}`);
  if (parent !== undefined) return text(excerpt(said, 4000), { to: parent.agent, inReplyTo: parent.id, subject: `Re: ${parent.subject}`.slice(0, 200) });
  const name = line(get(message, 'from.first_name'), 60);
  const handle = line(get(message, 'from.username'), 60);
  return text(`Telegram message from ${[name, handle && `@${handle}`].filter(Boolean).join(' ') || 'the Director'} in chat ${chat}:\n\n${excerpt(said, 4000)}`);
}

/** The kinds that Relay adds to the generic one (uplinks.ts `KINDS`). */
export const RELAY_KINDS: Record<Exclude<UplinkKind, 'generic'>, KindDef> = {
  github: { authentic: githubAuthentic, read: githubRead },
  linear: { authentic: linearAuthentic, read: linearRead },
  slack: { authentic: slackAuthentic, read: slackRead },
  telegram: { authentic: telegramAuthentic, read: telegramRead },
};

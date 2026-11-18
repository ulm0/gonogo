/**
 * Phone approvals, Path A (docs/phone-approvals-spec.md): a pending permission or hire request goes to the Director's Telegram chat
 * with buttons, and a press comes back through the Telegram uplink as a signed `callback_query`.
 *
 * Buttons carry `a:<kind>:<id>:<verdict>:<tag>` (phonetag.ts). For a permission the id is a short handle (`p7`) of this process's
 * map to the agent and the dialog number (`needSeq`); the answer is `Hub.answer(name, { go, needSeq })`, so a press that comes
 * late, for a dialog that was answered or replaced, does nothing. For a hire request the id is the Relief id, and only NO-GO and
 * Open are offered: the role text is not shown on a phone, so GO is the page's (docs/relief-spec.md). A dialog or a request whose
 * text was cut also gets NO-GO and Open only.
 *
 * Every id starts with a nonce made at start: the signing secret survives a restart but the handles do not, so without it an old
 * "GO p1" would approve the new dialog p1. A button of before a restart answers "too late".
 * shortcut: the handles are in memory and bounded.
 * shortcut: Telegram does not say who pressed beyond the chat; the chat of the target is the Director's, as for messages.
 */
import { randomBytes } from 'node:crypto';
import type { DownlinkRef, Logger } from '../shared/protocol.js';
import { callbackData, verifyCallback } from './phonetag.js';
import type { PhoneVerdict } from './phonetag.js';
import type { Relay } from './relay.js';
import type { Relief } from './relief.js';
import type { ButtonPress } from './uplinks.js';
import type { Hub } from '../shared/protocol.js';

/** Presses taken in a minute: more are told "slow down". */
export const PHONE_PRESS_MAX = 10;
const PRESS_WINDOW_MS = 60_000;
const HANDLES_MAX = 200;
const OPEN_NOTE = 'Open gonogo to read it and answer';

export interface PhoneOptions {
  hub: Pick<Hub, 'answer'>;
  relief: Pick<Relief, 'decide'>;
  relay: Pick<Relay, 'phoneTelegram' | 'sendButtons' | 'telegramCall'>;
  /** The secret of the Telegram uplink that signs the buttons, or null when there is none. */
  secret(): string | null;
  now(): number;
  /** Tests give a fixed nonce; the default is random. */
  nonce?(): string;
  log: Logger;
}

export interface Phone {
  /** A permission dialog or a hire request is pending: sends it with buttons when the Telegram path is on. */
  approval(ref: DownlinkRef, text: string): void;
  /** A button was pressed. Answers the press on Telegram, acts, then takes the buttons off the message. */
  press(secret: string, press: ButtonPress): Promise<void>;
}

const PERMISSION_CUT = '…';

export function createPhone(options: PhoneOptions): Phone {
  const { hub, relief, relay, log } = options;
  /** 4 hex characters, new for each process: part of every id that is signed. */
  const nonce = options.nonce?.() ?? randomBytes(2).toString('hex');
  const handles = new Map<string, { agent: string; seq: number }>();
  let handleSeq = 0;
  let taken: number[] = [];

  const reply = (press: ButtonPress, text: string): Promise<boolean> => relay.telegramCall('answerCallbackQuery', { callback_query_id: press.queryId, text });
  const clear = (press: ButtonPress): Promise<boolean> =>
    press.messageId === '' ? Promise.resolve(false) : relay.telegramCall('editMessageReplyMarkup', { message_id: Number(press.messageId), reply_markup: { inline_keyboard: [] } });

  return {
    approval(ref, text) {
      if (!relay.phoneTelegram()) return;
      const secret = options.secret();
      if (secret === null) return;
      const cut = text.endsWith(PERMISSION_CUT);
      let id: string;
      let verdicts: PhoneVerdict[];
      let shown = text;
      if (ref.kind === 'permission') {
        handleSeq += 1;
        id = `p${nonce}${handleSeq}`;
        handles.set(id, { agent: ref.agent, seq: ref.seq });
        if (handles.size > HANDLES_MAX) handles.delete(handles.keys().next().value as string);
        verdicts = cut ? ['nogo', 'open'] : ['go', 'nogo'];
        if (cut) shown = `${text}\n(truncated: open gonogo to see all of it)`;
      } else {
        id = `r${nonce}${ref.id}`;
        verdicts = ['nogo', 'open'];
        shown = `${text}\n(role text: open gonogo to read it)`;
      }
      const label: Record<PhoneVerdict, string> = { go: 'GO', nogo: 'NO-GO', open: 'Open' };
      const buttons = verdicts.flatMap((verdict) => {
        const data = callbackData(secret, { kind: ref.kind, id, verdict });
        return data === null ? [] : [{ text: label[verdict], callback_data: data }];
      });
      if (buttons.length === 0) return;
      void relay.sendButtons(shown, { inline_keyboard: [buttons] }).catch(() => undefined);
    },

    async press(secret, press) {
      const t = options.now();
      // a bad tag counts too: somebody guessing tags must not have more than the limit of tries
      taken = taken.filter((at) => t - at < PRESS_WINDOW_MS);
      if (taken.length >= PHONE_PRESS_MAX) {
        await reply(press, 'Too many presses: wait a minute');
        return;
      }
      taken.push(t);
      // the Director may have turned the path off since the button was sent
      if (!relay.phoneTelegram()) {
        await reply(press, 'Phone approvals are off');
        return;
      }
      const call = verifyCallback(secret, press.data);
      if (call === null) {
        log.debug('phone: a button with a wrong tag');
        await reply(press, 'Invalid button');
        return;
      }
      if (call.verdict === 'open') {
        await reply(press, OPEN_NOTE);
        return;
      }
      const go = call.verdict === 'go';
      try {
        if (call.kind === 'permission') {
          const found = handles.get(call.id);
          if (found === undefined) throw new Error('too late: that dialog is gone');
          hub.answer(found.agent, { go, needSeq: found.seq });
        } else {
          // GO is never offered for a hire request; a signed one that was made by hand is refused all the same
          if (go) throw new Error('hire requests are approved in gonogo');
          // r<nonce><id>: a button of another process is a request that is gone
          if (!call.id.startsWith(`r${nonce}`)) throw new Error('too late: that request is gone');
          await relief.decide(call.id.slice(1 + nonce.length), 'no-go', { kind: 'user' });
        }
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        log.debug(`phone: ${call.kind} ${call.id}: ${why}`);
        await reply(press, why.startsWith('too late') || /answered or replaced|not asking|no such hire/.test(why) ? 'Too late: already answered' : cutWhy(why));
        await clear(press);
        return;
      }
      await reply(press, go ? 'Sent GO' : 'Sent NO-GO');
      await clear(press);
    },
  };
}

const cutWhy = (why: string): string => (why.length > 150 ? `${why.slice(0, 149)}…` : why);

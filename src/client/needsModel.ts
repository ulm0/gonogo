/** The "Needs you" strip of COMMS: which messages wait on the Director, with no React. */
import type { DownlinkItem, DownlinkMessage } from '../shared/protocol.js';

/** A message that asks for a go or a no-go. */
const GO_NOGO = /\bgo\s*(?:\/|or)\s*no[\s-]?go\b/i;

/** The words of a message that decide whether it asks something: its subject and the start of its text. */
const askText = (item: DownlinkMessage): string => `${item.subject}\n${item.body.slice(0, 400)}`;

export const wantsGoNoGo = (item: DownlinkMessage): boolean => GO_NOGO.test(askText(item));

/**
 * shortcut: a message "asks" when it is unread, not archived, and says go/no-go or has a question mark in its subject or its first 400 characters. There is no field for it on the
 * message yet; a flag set by send_message would be exact, and this reads it from the words until the server has one. A message that only looks like a question leaves with "Not a question".
 */
export const isAsk = (item: DownlinkItem): item is DownlinkMessage => item.type === 'message' && !item.read && !item.archived && (wantsGoNoGo(item) || askText(item).includes('?'));

/** The messages that wait for an answer, the one that has waited longest first (an old question is the one forgotten). */
export const asksOf = (items: readonly DownlinkItem[]): DownlinkMessage[] => items.filter(isAsk).sort((a, b) => a.at - b.at);

/** What the strip counts: consoles that wait on you (a permission or a go), messages, hire requests and handoffs. */
export const needsCount = (consoles: number, asks: number, relief: number, handoffs: number): number => consoles + asks + relief + handoffs;

export const needsTitle = (n: number): string => (n === 1 ? 'Needs you: 1 answer' : `Needs you: ${n} answers`);

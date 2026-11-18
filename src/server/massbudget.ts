/**
 * Mass Budget: how big each agent's memory.md is, and a request to the agent to condense it (docs/mass-budget-spec.md).
 *
 * gonogo never writes memory.md: the agent may be writing it. A request is a message from the Director through the hub, so Max Q,
 * Redline and held mail apply, and the agent rewrites its own file. What gonogo does write is one copy, memory.md.bak, taken from
 * the bytes it read when the request is sent and put in place only after the hub took the message (so a refused request keeps
 * the older copy). The file is opened without following a symbolic link and is never read past MEMORY_READ_MAX bytes.
 *
 * shortcut: the lines and the bytes of the soft limit are constants (the role text tells an agent to keep its file under 200
 * lines); make them options if anyone runs agents that need more.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { providerInfo } from '../shared/protocol.js';
import type { AgentView, Logger, MemoryView, ReflectResult, SendResult, UserMessageRequest } from '../shared/protocol.js';
import { FILE_MODE, MEMORY_FILE } from './constants.js';
import { HubError } from './hub.js';

export const MEMORY_BACKUP_FILE = `${MEMORY_FILE}.bak`;
/** The role text asks for under 200 lines; the size limit is what 200 lines of notes come to. */
export const MEMORY_SOFT_LINES = 200;
export const MEMORY_SOFT_BYTES = 16 * 1024;
/** What the request asks the agent to bring the file down to. */
export const MEMORY_TARGET_LINES = 100;
/** A larger file is not copied or counted: trim it by hand. */
export const MEMORY_READ_MAX = 1024 * 1024;

export interface MassBudgetOptions {
  /** Absolute path of agents/<name>/memory.md (Launcher.memoryPath). */
  memoryPath(name: string): string;
  /** The agent of that name, or undefined. */
  agent(name: string): AgentView | undefined;
  /** Hub.sendFromUser. May throw a HubError. */
  send(request: UserMessageRequest): SendResult;
  log: Logger;
}

export interface MassBudget {
  view(name: string): Promise<MemoryView>;
  /** Copies memory.md to memory.md.bak and asks the agent to condense it. Throws a HubError (not_found, conflict) for what cannot be done. */
  reflect(name: string): Promise<ReflectResult>;
}

/** The message to the agent. Everything it needs is in it: the file, the size, what to keep, what to drop, how to write it and how to answer. */
export function reflectBody(input: { name: string; path: string; bytes: number; lines: number }): string {
  return [
    'The Director asks you to condense your memory file.',
    `File: ${input.path} (${input.bytes} bytes, ${input.lines} lines). gonogo copied it to ${input.path}.bak when it sent this message: do not use that copy as notes and do not edit it.`,
    'When your current step is done:',
    '1. Read the whole file.',
    `2. Write a shorter version of at most ${MEMORY_TARGET_LINES} lines. Keep what is still true and still useful: decisions and their reasons, rules and conventions, paths, commands, names, ids and open problems. Drop what is done, repeated or replaced, and any step-by-step log of what you did. Merge notes on one subject. Add nothing that is not in the file.`,
    '3. A finding that every agent should know goes to the Mission Log with log_write, and leaves your file.',
    `4. Replace the file with the new text in one write. Keep the first line "# Memory of ${input.name}" and plain markdown. Do not change any other file.`,
    '5. Then send_message to "user" with the subject "Memory condensed" and one sentence: the lines before and after. If the file is already short and has nothing to drop, change nothing and say so in one sentence.',
  ].join('\n');
}

const conflict = (message: string): HubError => new HubError('conflict', message);
const lineCount = (text: Buffer): number => {
  if (text.length === 0) return 0;
  let lines = 0;
  for (const byte of text) if (byte === 0x0a) lines += 1;
  return text[text.length - 1] === 0x0a ? lines : lines + 1;
};

interface Read {
  bytes: number;
  /** The content, or null when the file is larger than MEMORY_READ_MAX. */
  data: Buffer | null;
  changedAt: number;
}

/** The file as it is, read without following a link. null when it is not there. A link, a folder or a device is refused. */
async function readMemory(path: string): Promise<Read | null> {
  let handle;
  try {
    // O_NONBLOCK: opening a named pipe in that place must not wait for a writer
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw conflict(`${basename(path)} is a symbolic link: gonogo does not follow it`);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw conflict(`${basename(path)} is not a regular file`);
    if (info.size > MEMORY_READ_MAX) return { bytes: info.size, data: null, changedAt: info.mtimeMs };
    const data = Buffer.alloc(info.size);
    let got = 0;
    while (got < data.length) {
      const { bytesRead } = await handle.read(data, got, data.length - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return { bytes: got, data: data.subarray(0, got), changedAt: info.mtimeMs };
  } finally {
    await handle.close();
  }
}

export function createMassBudget(options: MassBudgetOptions): MassBudget {
  const { log } = options;
  /** One request per agent at a time: a double click must not send the message twice. */
  const asking = new Set<string>();

  const known = (name: string): AgentView => {
    const agent = options.agent(name);
    if (!agent) throw new HubError('not_found', 'unknown agent');
    if (agent.provider === 'custom') throw new HubError('not_found', `${name} runs a custom command: it has no memory file`);
    return agent;
  };

  const backupOf = async (path: string): Promise<MemoryView['backup']> => {
    try {
      const info = await lstat(`${path}.bak`);
      return info.isFile() ? { bytes: info.size, at: info.mtimeMs } : null;
    } catch {
      return null;
    }
  };

  const describe = async (path: string, read: Read | null): Promise<MemoryView> => {
    const bytes = read?.bytes ?? 0;
    const lines = read === null ? 0 : read.data === null ? null : lineCount(read.data);
    return {
      exists: read !== null,
      bytes,
      lines,
      softLines: MEMORY_SOFT_LINES,
      softBytes: MEMORY_SOFT_BYTES,
      over: bytes > MEMORY_SOFT_BYTES || (lines ?? Infinity) > MEMORY_SOFT_LINES,
      changedAt: read?.changedAt ?? null,
      backup: await backupOf(path),
    };
  };

  return {
    async view(name) {
      known(name);
      const path = options.memoryPath(name);
      return describe(path, await readMemory(path));
    },

    async reflect(name) {
      known(name);
      if (asking.has(name)) throw conflict(`a request to ${name} is being sent`);
      asking.add(name);
      try {
        const path = options.memoryPath(name);
        const read = await readMemory(path);
        if (read === null) throw conflict(`${name} has no memory file yet: start it first`);
        if (read.data === null) throw conflict(`${MEMORY_FILE} of ${name} is ${Math.round(read.bytes / 1024)} KiB, more than the ${MEMORY_READ_MAX / 1024} KiB gonogo copies: trim it by hand`);
        // written first, put in place after the hub took the message
        const tmp = join(dirname(path), `.${MEMORY_BACKUP_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
        await writeFile(tmp, read.data, { mode: FILE_MODE, flag: 'wx' }).catch(async (error: unknown) => {
          // a full disk leaves half a file behind
          await rm(tmp, { force: true });
          throw error;
        });
        let send: SendResult;
        try {
          send = options.send({ to: name, subject: 'Mass Budget: condense your memory file', body: reflectBody({ name, path, bytes: read.bytes, lines: lineCount(read.data) }) });
        } catch (error) {
          await rm(tmp, { force: true });
          throw error;
        }
        if (send.ok) {
          // rename puts the copy in place of a link too, never through it
          await rename(tmp, `${path}.bak`).catch(async (error: unknown) => {
            log.warn(`could not write ${MEMORY_BACKUP_FILE} of ${name}`, error);
            await rm(tmp, { force: true });
          });
        } else {
          await rm(tmp, { force: true });
        }
        return { send, memory: await describe(path, await readMemory(path)) };
      } finally {
        asking.delete(name);
      }
    },
  };
}

/**
 * `gonogo auth ...` (docs/login-spec.md): the account from the command line.
 *
 *   gonogo auth reset [--home <dir>]                          empty the account (offline write; a running gonogo notices and alerts)
 *   gonogo auth status [--home <dir>]                         whether an account exists, over the local socket
 *   gonogo auth key add <name> [--scope read|act|full] [--expires 90d] [--remote]
 *   gonogo auth key list | gonogo auth key revoke <id>
 *   gonogo auth confirm                                       the password on stdin: lifts the pause after a tamper alarm
 *
 * Everything but `reset` goes through the running gonogo's local socket (`<home>/run/api.sock`), so the file permissions are the credential
 * and nothing is typed on a command line that `ps` could show.
 */
import http from 'node:http';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { resetAuthFiles } from './auth.js';

export const AUTH_USAGE = `Usage: gonogo auth reset [--home <dir>]
       gonogo auth status [--home <dir>]
       gonogo auth key add <name> [--scope read|act|full] [--expires 90d] [--remote] [--home <dir>]
       gonogo auth key list [--home <dir>]
       gonogo auth key revoke <id> [--home <dir>]
       gonogo auth confirm [--home <dir>]     (the password is read from standard input)

  reset     empties the account: every session and key ends, login is off until a new account is set up with the new setup token,
            which is written to <home>/setup-token and is not printed
  key add   prints a key once; the default scope is read and the default life 90 days; --remote lets it be used from a public name
  confirm   after "auth.json changed outside gonogo", remote logins stay refused until the Director confirms with the password
`;

export interface AuthIo {
  out(text: string): void;
  err(text: string): void;
  /** The first line of standard input (the password for `confirm`). */
  readLine(): Promise<string>;
}

/** One call to the running gonogo over its local socket. */
export function socketCall(socketPath: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ socketPath, path, method, headers: { host: 'localhost', ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof value === 'object' && value !== null && !Array.isArray(value)) parsed = value as Record<string, unknown>;
        } catch {
          // an empty or non-JSON answer: the status says it
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

const DAYS = /^(\d{1,4})d$/;

export async function authCommand(args: readonly string[], home: string, io: AuthIo): Promise<number> {
  const rest = [...args];
  const sock = join(home, 'run', 'api.sock');
  const running = (): boolean => {
    try {
      return statSync(sock).isSocket();
    } catch {
      return false;
    }
  };
  const need = (): boolean => {
    if (running()) return true;
    io.err(`gonogo auth: gonogo is not running (no ${sock}); start it first.\n`);
    return false;
  };
  const fail = (error: unknown): number => {
    io.err(`gonogo auth: could not reach gonogo on ${sock}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  };
  const said = (answer: { status: number; body: Record<string, unknown> }): string => (typeof answer.body.error === 'string' ? answer.body.error : `gonogo answered ${answer.status}`);

  const action = rest.shift();
  if (action === 'reset') {
    if (rest.length > 0) return (io.err(`gonogo auth: reset takes only --home\n\n${AUTH_USAGE}`), 2);
    io.out(`${resetAuthFiles(home)}\n`);
    return 0;
  }
  if (action === 'status') {
    if (!need()) return 1;
    try {
      const answer = await socketCall(sock, 'GET', '/api/auth/status');
      io.out(`login: ${String(answer.body.state)}${answer.body.locked === true ? ' (remote logins paused: confirm with `gonogo auth confirm`)' : ''}\n`);
      return 0;
    } catch (error) {
      return fail(error);
    }
  }
  if (action === 'confirm') {
    if (!need()) return 1;
    const password = (await io.readLine()).replace(/\r?\n$/, '');
    try {
      const answer = await socketCall(sock, 'POST', '/api/auth/confirm', { password });
      if (answer.status === 200) return (io.out(`${typeof answer.body.note === 'string' ? answer.body.note : 'confirmed: remote logins are allowed again'}\n`), 0);
      io.err(`gonogo auth: ${said(answer)}\n`);
      return 1;
    } catch (error) {
      return fail(error);
    }
  }
  if (action === 'key') {
    const sub = rest.shift();
    if (!need()) return 1;
    try {
      if (sub === 'list') {
        const answer = await socketCall(sock, 'GET', '/api/auth/account');
        const keys = Array.isArray(answer.body.keys) ? (answer.body.keys as Array<Record<string, unknown>>) : [];
        if (keys.length === 0) io.out('no API keys\n');
        for (const k of keys) {
          const last = typeof k.last === 'number' ? `last used ${new Date(k.last).toISOString()} from ${String(k.lastAddress)}` : 'never used';
          io.out(`${String(k.id)}  ${String(k.name)}  ${String(k.scope)}${k.remote === true ? ' remote' : ''}  expires ${new Date(Number(k.expires)).toISOString().slice(0, 10)}  ${last}\n`);
        }
        return 0;
      }
      if (sub === 'revoke') {
        const id = rest.shift();
        if (id === undefined || rest.length > 0) return (io.err(`gonogo auth: key revoke needs one key id\n`), 2);
        const answer = await socketCall(sock, 'DELETE', `/api/auth/keys/${encodeURIComponent(id)}`);
        if (answer.status === 200) return (io.out('revoked\n'), 0);
        io.err(`gonogo auth: ${said(answer)}\n`);
        return 1;
      }
      if (sub === 'add') {
        const name = rest.shift();
        if (name === undefined || name.startsWith('-')) return (io.err('gonogo auth: key add needs a name\n'), 2);
        let scope = 'read';
        let days: number | undefined;
        let remote = false;
        while (rest.length > 0) {
          const flag = rest.shift() as string;
          if (flag === '--remote') remote = true;
          else if (flag === '--scope' && rest.length > 0) scope = rest.shift() as string;
          else if (flag === '--expires' && rest.length > 0) {
            const m = DAYS.exec(rest.shift() as string);
            if (m === null) return (io.err('gonogo auth: --expires is a number of days such as 90d\n'), 2);
            days = Number(m[1]);
          } else return (io.err(`gonogo auth: key add: unexpected ${flag}\n`), 2);
        }
        const answer = await socketCall(sock, 'POST', '/api/auth/keys', { name, scope, remote, ...(days === undefined ? {} : { days }) });
        if (answer.status !== 201) return (io.err(`gonogo auth: ${said(answer)}\n`), 1);
        io.out(`${String(answer.body.key)}\n`);
        io.err(`key ${String(answer.body.id)} (${scope}${remote ? ', remote' : ''}) made. This is the only time it is shown.\n`);
        return 0;
      }
    } catch (error) {
      return fail(error);
    }
    return (io.err(`gonogo auth: key needs add, list or revoke\n\n${AUTH_USAGE}`), 2);
  }
  io.err(`gonogo auth: unknown command${action === undefined ? '' : ` "${action}"`}\n\n${AUTH_USAGE}`);
  return 2;
}

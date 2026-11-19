/**
 * Flight Rules: the login (docs/login-spec.md). Who is signed in, the sessions with REVOKE and LOG OUT EVERYWHERE, the API keys, the password,
 * and the pause after the tamper alarm. It says plainly what a session is worth: it can run anything on this machine.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import * as api from './api.js';
import type { AccountView } from './api.js';
import { passkeysSupported } from './passkey.js';
import { exposureText } from './exposure.js';

const when = (at: number | null): string => (at === null ? 'never' : new Date(at).toISOString().slice(0, 16).replace('T', ' '));
const fail = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Which names this gonogo answers on, and whether the login stands behind them (docs/expose-spec.md). */
function ExposureLine({ exposure, login, mfa }: { exposure: AccountView['exposure']; login: string; mfa: boolean }): ReactElement {
  const { line, warn } = exposureText(exposure, login, mfa);
  return (
    <p className={warn ? 'error' : 'hint'} role={warn ? 'alert' : undefined}>
      {line}
    </p>
  );
}

export function AccountBlock(): ReactElement {
  const id = useId();
  const [account, setAccount] = useState<AccountView | null>(null);
  /** 'unknown' while asking; 'fresh' and 'none' mean no account yet; 'plain' is a page that has the old token or a key and no session. */
  const [mode, setMode] = useState<'unknown' | 'fresh' | 'session' | 'plain'>('unknown');
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [scope, setScope] = useState('read');
  const [days, setDays] = useState('90');
  const [remote, setRemote] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [secret, setSecret] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [offPassword, setOffPassword] = useState('');
  const [offCode, setOffCode] = useState('');
  const [passkeyName, setPasskeyName] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      setAccount(await api.authAccount());
      setMode('session');
    } catch (e) {
      try {
        const status = await api.authStatus();
        setMode(status.state === 'account' ? 'plain' : 'fresh');
      } catch {
        setMode('plain');
      }
      if ((e as { status?: number }).status !== 401) setProblem(fail(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = (action: () => Promise<unknown>, after?: () => void): void => {
    setProblem(null);
    action().then(
      async () => {
        after?.();
        await load();
      },
      (e: unknown) => setProblem(fail(e)),
    );
  };

  const submitKey = (event: FormEvent): void => {
    event.preventDefault();
    setProblem(null);
    api.authMakeKey({ name: name.trim(), scope, days: days.trim() === '' ? null : Number(days), remote }).then(
      async (result) => {
        setMade(result.key);
        setName('');
        await load();
      },
      (e: unknown) => setProblem(fail(e)),
    );
  };
  const submitPassword = (event: FormEvent): void => {
    event.preventDefault();
    run(() => api.authChangePassword(current, next), () => {
      setCurrent('');
      setNext('');
    });
  };

  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        LOGIN
      </h2>
      <p className="hint">
        A signed-in session can run anything on this machine: it can type into every agent&apos;s terminal, including one that is allowed to do anything. Use a long password, keep the page off the internet unless you need it there, and run agents in a Clean Room when it is.
      </p>
      {mode === 'fresh' && (
        <p>
          No account yet: this install still opens with the address that has the key in it.{' '}
          <a className="btn" href="/setup">
            SET UP THE LOGIN
          </a>
        </p>
      )}
      {mode === 'plain' && <p className="hint">This tab is not signed in with an account, so the account is not shown. Log in to see the sessions and keys.</p>}
      {account !== null && mode === 'session' && (
        <>
          {account.locked && (
            <div className="flood rules-confirm" data-tone="nogo" role="alert">
              <p>gonogo saw its account file change outside gonogo. Remote logins are paused until you confirm with your password.</p>
              <div className="rules-row">
                <input className="input" type="password" autoComplete="current-password" aria-label="Password to confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                <button type="button" className="btn" data-kind="primary" onClick={() => run(() => api.authConfirm(confirm), () => setConfirm(''))}>
                  CONFIRM
                </button>
              </div>
            </div>
          )}
          <p>
            Signed in as <strong>{account.user}</strong>
            {account.host === 'public' ? '' : account.host === 'private' ? ' (plain http on your network: not encrypted)' : ' (this machine)'}.
          </p>
          <ExposureLine exposure={account.exposure} login={account.state} mfa={account.mfa.enabled} />
          <h3 className="label">SESSIONS</h3>
          <ul className="rules-list">
            {account.sessions.map((s) => (
              <li key={s.id}>
                <span>
                  {s.address} · {s.agent === '' ? 'unknown browser' : s.agent.slice(0, 60)} · last used {when(s.last)}
                  {s.id === account.current ? ' · this one' : ''}
                </span>
                <button type="button" className="btn" onClick={() => run(() => api.authRevokeSession(s.id))} disabled={s.id === account.current} aria-label={`Revoke the session from ${s.address}`}>
                  REVOKE
                </button>
              </li>
            ))}
          </ul>
          <div className="rules-row">
            <button type="button" className="btn" onClick={() => run(() => api.authLogoutAll())}>
              LOG OUT EVERYWHERE
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                run(
                  () => api.authLogout(),
                  () => location.assign('/login'),
                )
              }
            >
              LOG OUT
            </button>
          </div>
          <h3 className="label">API KEYS</h3>
          <ul className="rules-list">
            {account.keys.length === 0 && <li className="hint">No keys.</li>}
            {account.keys.map((k) => (
              <li key={k.id}>
                <span>
                  {k.name} · {k.scope}
                  {k.remote ? ' · remote' : ''} · expires {when(k.expires).slice(0, 10)} · last used {when(k.last)}
                  {k.lastAddress === null ? '' : ` from ${k.lastAddress}`}
                  {k.scope === 'full' ? ' · can do almost everything a session can' : ''}
                </span>
                <button type="button" className="btn" data-kind="danger" onClick={() => run(() => api.authRevokeKey(k.id))} aria-label={`Revoke the key ${k.name}`}>
                  REVOKE
                </button>
              </li>
            ))}
          </ul>
          <form className="rules-row" onSubmit={submitKey}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name" aria-label="Key name" maxLength={60} required />
            <select className="input" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Key scope">
              <option value="read">read</option>
              <option value="act">act (messages, answers, hold, resume)</option>
              <option value="full">full</option>
            </select>
            <input className="input" value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" aria-label="Days until it expires" size={4} />
            <label className="staff-check">
              <input type="checkbox" className="check" checked={remote} onChange={(e) => setRemote(e.target.checked)} />
              usable from a public name
            </label>
            <button type="submit" className="btn" data-kind="primary">
              MAKE KEY
            </button>
          </form>
          {made !== null && (
            <div className="flood rules-confirm" data-tone="go" role="status">
              <p>Copy this key now. It is not shown again.</p>
              <p className="lcd">{made}</p>
              <button type="button" className="btn" onClick={() => setMade(null)}>
                DONE
              </button>
            </div>
          )}
          <h3 className="label">SECOND FACTOR (TOTP)</h3>
          {!account.mfa.enabled && secret === null && (
            <>
              <p className="hint">An authenticator app makes a six-digit code every 30 seconds. With it on, signing in and the changes that matter ask for a code. A public address cannot be signed in to without it.</p>
              <div className="rules-row">
                <button type="button" className="btn" onClick={() => run(async () => setSecret(await api.authMfaBegin()))}>
                  TURN ON
                </button>
              </div>
            </>
          )}
          {!account.mfa.enabled && secret !== null && (
            <form
              className="rules-confirm flood"
              data-tone="go"
              onSubmit={(event) => {
                event.preventDefault();
                run(async () => setRecovery(await api.authMfaEnable(code)), () => {
                  setSecret(null);
                  setCode('');
                });
              }}
            >
              <p>Add this to your authenticator (type the key, or open the address as a link on this device), then give the first code.</p>
              <p className="lcd">{secret.secret}</p>
              <p className="lcd">{secret.uri}</p>
              <div className="rules-row">
                <input className="input" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" aria-label="First code" placeholder="123456" required />
                <button type="submit" className="btn" data-kind="primary">
                  CONFIRM
                </button>
              </div>
            </form>
          )}
          {recovery !== null && (
            <div className="flood rules-confirm" data-tone="go" role="status">
              <p>Keep these recovery codes somewhere safe. Each works once, instead of a code. They are not shown again.</p>
              <p className="lcd">{recovery.join('  ')}</p>
              <button type="button" className="btn" onClick={() => setRecovery(null)}>
                DONE
              </button>
            </div>
          )}
          {account.mfa.enabled && (
            <>
              <p>On. {account.mfa.recoveryLeft} recovery codes left.</p>
              <form
                className="rules-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  run(async () => setRecovery(await api.authMfaRecovery(offPassword, offCode)), () => {
                    setOffPassword('');
                    setOffCode('');
                  });
                }}
              >
                <input className="input" type="password" autoComplete="current-password" value={offPassword} onChange={(e) => setOffPassword(e.target.value)} placeholder="Password" aria-label="Password" required />
                <input className="input" value={offCode} onChange={(e) => setOffCode(e.target.value)} placeholder="Code or recovery code" aria-label="Code or recovery code" autoComplete="one-time-code" required />
                <button type="submit" className="btn">
                  NEW RECOVERY CODES
                </button>
                <button
                  type="button"
                  className="btn"
                  data-kind="danger"
                  onClick={() => run(() => api.authMfaDisable(offPassword, offCode), () => {
                    setOffPassword('');
                    setOffCode('');
                  })}
                >
                  TURN OFF
                </button>
              </form>
            </>
          )}
          <h3 className="label">PASSKEYS</h3>
          <ul className="rules-list">
            {account.passkeys.length === 0 && <li className="hint">No passkeys.</li>}
            {account.passkeys.map((p) => (
              <li key={p.id}>
                <span>
                  {p.name} · for {p.rpId} · added {when(p.created).slice(0, 10)} · last used {when(p.last)}
                  {p.backedUp ? ' · synced' : ''}
                </span>
                <button type="button" className="btn" data-kind="danger" onClick={() => run(() => api.authPasskeyRemove(p.id, offPassword, offCode), () => {
                    setOffPassword('');
                    setOffCode('');
                  })} aria-label={`Remove the passkey ${p.name}`}>
                  REMOVE
                </button>
              </li>
            ))}
          </ul>
          {account.passkeys.length > 0 && <p className="hint">To remove a passkey, give your password and a code in the fields of the second factor above, then REMOVE.</p>}
          {account.passkeyHere !== null && passkeysSupported() && !account.mfa.enabled ? (
            <p className="hint">Turn on the second factor (TOTP) first: it is the way back if the name of this page ever changes and the passkey stops working.</p>
          ) : account.passkeyHere !== null && passkeysSupported() ? (
            <form
              className="rules-row"
              onSubmit={(event) => {
                event.preventDefault();
                run(() => api.authPasskeyAdd(passkeyName.trim() || 'passkey'), () => setPasskeyName(''));
              }}
            >
              <input className="input" value={passkeyName} onChange={(e) => setPasskeyName(e.target.value)} placeholder="Name (this laptop, my phone)" aria-label="Passkey name" maxLength={60} />
              <button type="submit" className="btn">
                ADD A PASSKEY FOR {account.passkeyHere}
              </button>
            </form>
          ) : (
            <p className="hint">A passkey is made on a public name opened over https, in a browser that has them: this page is neither, or not both. A passkey works only at the name it was made for, and is the password and the second factor in one step.</p>
          )}
          <h3 className="label">PASSWORD</h3>
          <form className="rules-row" onSubmit={submitPassword}>
            <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" aria-label="Current password" required />
            <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password (12 or more)" aria-label="New password" minLength={12} required />
            <button type="submit" className="btn">
              CHANGE PASSWORD
            </button>
          </form>
          <p className="hint">Changing it ends every other session.</p>
        </>
      )}
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

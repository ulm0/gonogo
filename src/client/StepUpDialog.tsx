/**
 * Step-up (docs/login-spec.md): a change from the short list (a hire with a command of its own, the permissions, a secret, a key, ...) made from
 * a session whose password was checked more than five minutes ago asks for it again. The server says so with a 403 `stepUp`; api.ts calls this
 * dialog, confirms with the answer and runs the change once more. A modal <dialog>, so the keyboard stays in it.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import * as api from './api.js';
import type { StepUpAnswer } from './api.js';
import { passkeysSupported } from './passkey.js';

interface Asking {
  needsCode: boolean;
  passkey: boolean;
  message: string;
  resolve(answer: StepUpAnswer | null): void;
}

export function StepUpDialog(): ReactElement {
  const id = useId();
  const dialog = useRef<HTMLDialogElement | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => api.onStepUp((needsCode, message, passkey) => new Promise<StepUpAnswer | null>((resolve) => setAsking({ needsCode, passkey: passkey && passkeysSupported(), message, resolve }))), []);
  useEffect(() => {
    const d = dialog.current;
    if (d === null) return;
    if (asking !== null && !d.open) d.showModal();
    else if (asking === null && d.open) d.close();
  }, [asking]);

  const finish = (answer: StepUpAnswer | null): void => {
    asking?.resolve(answer);
    setAsking(null);
    setPassword('');
    setCode('');
  };
  const usePasskey = (): void => {
    setProblem(null);
    api.passkeyStepUpAnswer().then(
      (answer) => finish(answer),
      (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
    );
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    finish({ password, code });
  };

  return (
    <dialog ref={dialog} className="stepup module" aria-labelledby={`${id}-title`} onCancel={(e) => { e.preventDefault(); finish(null); }}>
      <form onSubmit={submit} className="stepup-form">
        <h2 className="label" id={`${id}-title`}>
          CONFIRM IT IS YOU
        </h2>
        <p>{asking?.message ?? ''}</p>
        {asking?.passkey === true && (
          <button type="button" className="btn" onClick={usePasskey}>
            USE A PASSKEY
          </button>
        )}
        {problem !== null && (
          <p className="error" role="alert">
            {problem}
          </p>
        )}
        <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" placeholder="Password" autoFocus={asking?.passkey !== true} required />
        {asking?.needsCode === true && <input className="input" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code from your authenticator, or a recovery code" placeholder="Code or recovery code" autoComplete="one-time-code" required spellCheck={false} />}
        <div className="stepup-row">
          <button type="button" className="btn" onClick={() => finish(null)}>
            CANCEL
          </button>
          <button type="submit" className="btn" data-kind="primary">
            CONFIRM
          </button>
        </div>
      </form>
    </dialog>
  );
}

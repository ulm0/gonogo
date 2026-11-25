/**
 * Step-up (docs/login-spec.md): a change from the short list (a hire with a command of its own, the permissions, a secret, a key, ...) made from
 * a session whose password was checked more than five minutes ago asks for it again. The server says so with a 403 `stepUp`; api.ts calls this
 * dialog, confirms with the answer and runs the change once more. A modal dialog (Radix), so the keyboard stays in it; Esc cancels, a press outside does not.
 */
import { useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import * as api from './api.js';
import type { StepUpAnswer } from './api.js';
import { passkeysSupported } from './passkey.js';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog.js';
import { Input } from '@/ui/input.js';

interface Asking {
  needsCode: boolean;
  passkey: boolean;
  message: string;
  resolve(answer: StepUpAnswer | null): void;
}

export function StepUpDialog(): ReactElement {
  const [asking, setAsking] = useState<Asking | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(
    () =>
      api.onStepUp(
        (needsCode, message, passkey) =>
          new Promise<StepUpAnswer | null>((resolve) =>
            setAsking((old) => {
              // a second ask while one is open: the first one is cancelled, so its call does not wait for ever
              old?.resolve(null);
              return { needsCode, passkey: passkey && passkeysSupported(), message, resolve };
            }),
          ),
      ),
    [],
  );

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
    <Dialog open={asking !== null} onOpenChange={(open) => !open && finish(null)}>
      <DialogContent className="stepup module block w-[min(92vw,380px)] p-4 text-inherit sm:max-w-none" aria-describedby={undefined} onInteractOutside={(e) => e.preventDefault()}>
        <form onSubmit={submit} className="grid gap-2.5 [&_p]:m-0">
          <DialogTitle className="label leading-normal">CONFIRM IT IS YOU</DialogTitle>
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
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" placeholder="Password" autoFocus={asking?.passkey !== true} required />
          {asking?.needsCode === true && <Input value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code from your authenticator, or a recovery code" placeholder="Code or recovery code" autoComplete="one-time-code" required spellCheck={false} />}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => finish(null)}>
              CANCEL
            </button>
            <button type="submit" className="btn" data-kind="primary">
              CONFIRM
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

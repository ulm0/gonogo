/**
 * The first step of a new install (docs/first-run-audit.md, point 3): while no account exists, the first screen says so and leads to the setup. Before this the only
 * sign was a key in Flight Rules, so a newcomer who opened the address gonogo prints never met the setup at all, and anyone who had that address could use the install.
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import * as api from './api.js';

export function SetupStrip(): ReactElement | null {
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    let live = true;
    // a status that cannot be read says nothing: the strip is for a state that is known
    api.authStatus().then(
      (status) => live && setFresh(status.state !== 'account'),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  if (!fresh) return null;
  return (
    <aside className="setup-strip flood" data-tone="amber" aria-label="Set up your login">
      <p>
        <strong>Step one: set up your login.</strong> There is none yet, so anyone who has this address can use gonogo. The setup asks for the setup token: it was printed where gonogo started, and it is in the file <code>setup-token</code> in gonogo&apos;s home folder.
      </p>
      <a className="btn" data-kind="primary" href="/setup">
        Set up your login
      </a>
    </aside>
  );
}

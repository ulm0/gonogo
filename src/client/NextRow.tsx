/** A setting as a row (docs/ui-semantic.md, "Flight Rules"): its name, what it is now, and Edit ▾ that opens the existing block in place. */
import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

/** What a setting is now: asked once when the row is shown; null while it is on its way or if the answer failed. */
export function useValue(ask: () => Promise<string>): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    ask().then(
      (v) => live && setValue(v),
      () => live && setValue('unknown'),
    );
    return () => {
      live = false;
    };
    // asked once: the block inside says the new value when it is saved
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return value;
}

export function NextRow({ name, now, children }: { name: string; now: string | null; children: ReactNode }): ReactElement {
  return (
    <details className="next-row">
      <summary>
        <span className="next-row-name">{name}</span>
        <span className="next-row-now">{now ?? '…'}</span>
        <span className="btn next-row-edit" data-kind="quiet" aria-hidden="true">
          Edit ▾
        </span>
      </summary>
      <div className="next-row-body">{children}</div>
    </details>
  );
}

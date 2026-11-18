/**
 * Room editor: the quiet key in the header of Operations, and the check every way in shares (the Patch Panel too): the editor is for
 * a pointer and a wide screen, so under 900 pixels EDIT ROOM says so instead of opening.
 */
import type { ReactElement } from 'react';
import { EDIT_MIN_WIDTH, EDIT_TOO_NARROW } from './roomedit.js';
import { setEditingRoom } from './store.js';
import { useRun } from './WallView.js';

/** Can the room be edited here? */
export const canEditHere = (): boolean => typeof matchMedia === 'function' && matchMedia(`(min-width: ${EDIT_MIN_WIDTH}px)`).matches;

/** What EDIT ROOM does: opens the editor, or throws the reason (the Patch Panel and the key show it). */
export function startEditing(): void {
  if (!canEditHere()) throw new Error(EDIT_TOO_NARROW);
  setEditingRoom(true);
}

export function EditRoomKey(): ReactElement {
  const { error, run } = useRun();
  return (
    <>
      <button type="button" className="btn operations-edit" data-kind="quiet" onClick={() => run(async () => startEditing())}>
        Edit room
      </button>
      {error !== null && (
        <span className="hint" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

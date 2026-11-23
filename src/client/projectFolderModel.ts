/** The words of the Project folder row of Flight Rules (docs/features/rooms.md, "Folders"). */
import type { ProjectFolderView } from '../shared/protocol.js';

/** Where the folder in force comes from, in words. */
export const sourceText = (source: ProjectFolderView['source']): string => (source === 'set' ? 'set' : 'default: the folder gonogo started in');

/** The line of the row: the folder, and "(default)" when nobody chose it. */
export const rowText = (view: Pick<ProjectFolderView, 'dir' | 'source'>): string => (view.source === 'set' ? view.dir : `${view.dir} (default)`);

/** After a change the boss that runs keeps its folder: a restart puts it in the new one. */
export const bossNeedsRestart = (view: Pick<ProjectFolderView, 'dir' | 'boss'>): boolean => view.boss !== null && view.boss.dir !== view.dir;

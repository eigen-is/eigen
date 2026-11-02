// The command palette's static catalog: every Go to, New and view command in one list, which the action
// source filters and ranks, and the few the empty palette suggests. The Selection commands are not here:
// they are built from what a page publishes.

import type { Command } from '@workspace/lib/types/command-palette';
import { createCommands } from './creates';
import { navCommands } from './nav';
import { viewCommands } from './view';

export const allCommands: Command[] = [...navCommands, ...createCommands, ...viewCommands];

// The commands the empty palette lists under Suggested.
export const SUGGESTED_COMMAND_IDS = ['nav.mail', 'nav.drive', 'nav.calendar', 'create.doc', 'nav.space'];

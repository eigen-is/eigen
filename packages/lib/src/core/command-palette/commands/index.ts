import type { Command } from '@workspace/lib/types/command-palette';
import { createCommands } from './creates';
import { navCommands } from './nav';
import { viewCommands } from './view';

export const allCommands: Command[] = [...navCommands, ...createCommands, ...viewCommands];

// Curated subset shown in the empty-state Suggested section.
export const SUGGESTED_COMMAND_IDS = ['nav.mail', 'nav.drive', 'nav.calendar', 'create.doc', 'nav.space'];

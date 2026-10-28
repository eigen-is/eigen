// The slash commands of the chat composer: the list the suggestion popup shows, which commands need a space after
// them, and the commands that run in the browser and never reach the server, such as /help and /whoami. The server
// parses the commands it stores as messages itself.

import { validateCommand } from '../../validation';
import { EMOTE_COMMANDS, getEmoteCommand, resolveEmoteKey } from './emotes';

export { getEmoteCommand, resolveEmoteKey };

// All valid slash command strings
export const SLASH_COMMANDS = [
    '/help',
    '/inspect',
    '/look',
    '/finger',
    '/whoami',
    '/me',
    '/invite',
    '/whisper',
    '/tell',
    '/reply',
    ...EMOTE_COMMANDS.flatMap((c) => [`/${c.key}`, ...(c.aliases ?? []).map((a) => `/${a}`)]),
];

// Help entries for the suggestion popup — priority commands first, then emotes alphabetically
export const COMMANDS_HELP = [
    { cmd: '/help', desc: 'List of available slash commands' },
    { cmd: '/whisper, /tell [User] [Message]', desc: 'Send private message' },
    { cmd: '/reply [Message]', desc: 'Reply to the last whisper' },
    { cmd: '/invite [User]', desc: 'Invite user to the room' },
    { cmd: '/inspect, /look, /finger [User]', desc: 'Inspect a user' },
    { cmd: '/whoami', desc: 'Inspect yourself' },
    { cmd: '/me [action]', desc: 'Perform a custom emote' },
    ...[...EMOTE_COMMANDS]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((c) => ({
            cmd: c.aliases ? `/${c.key}, ${c.aliases.map((a) => `/${a}`).join(', ')}` : `/${c.key}`,
            desc: c.desc,
        })),
];

// Set of emote commands that do NOT need a space appended after selection
// (they can be sent immediately without arguments)
const noSpaceCommands = new Set([
    '/help',
    '/whoami',
    ...EMOTE_COMMANDS.filter((c) => !c.requiresTarget).flatMap((c) => [
        `/${c.key}`,
        ...(c.aliases ?? []).map((a) => `/${a}`),
    ]),
]);

export function commandNeedsSpace(command: string): boolean {
    return !noSpaceCommands.has(command);
}

type LocalCommand =
    | { kind: 'help' }
    | { kind: 'whoami' }
    | { kind: 'inspect'; target: string }
    | { kind: 'invite'; target: string }
    | { kind: 'reply'; content: string }
    | { kind: 'error'; error: string }
    | null;

export function getLocalCommand(raw: string): LocalCommand {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('/')) return null;

    const validation = validateCommand(trimmed);

    if (!validation.valid) {
        return { kind: 'error', error: validation.error };
    }

    if (validation.kind === 'help') return { kind: 'help' };
    if (validation.kind === 'whoami') return { kind: 'whoami' };

    for (const cmd of ['/inspect ', '/look ', '/finger ']) {
        if (trimmed.startsWith(cmd)) {
            const target = trimmed.slice(cmd.length).trim();
            if (target) return { kind: 'inspect', target };
        }
    }

    if (trimmed.startsWith('/invite ')) {
        const target = trimmed.slice(8).trim();
        if (target) return { kind: 'invite', target };
    }

    if (trimmed.startsWith('/reply ')) {
        return { kind: 'reply', content: trimmed.slice(7) };
    }

    return null;
}

export function isUnknownCommand(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('/')) return false;
    const cmd = trimmed.split(' ')[0].toLowerCase();
    return !SLASH_COMMANDS.includes(cmd);
}

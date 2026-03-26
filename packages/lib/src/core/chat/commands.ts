import {validateCommand} from '../../validation';
import {EMOTE_COMMANDS, resolveEmoteKey, getEmoteCommand, isEmoteCommand} from './emotes';

export {resolveEmoteKey, getEmoteCommand, isEmoteCommand};

// All valid slash command strings
export const SLASH_COMMANDS = [
    '/help',
    '/inspect', '/look', '/finger',
    '/me',
    '/invite',
    '/whisper', '/tell',
    '/reply',
    ...EMOTE_COMMANDS.flatMap(c => [`/${c.key}`, ...(c.aliases ?? []).map(a => `/${a}`)]),
];

// Help entries for the suggestion popup
export const COMMANDS_HELP = [
    {cmd: '/help', desc: 'List of available slash commands'},
    {cmd: '/inspect, /look, /finger [User]', desc: 'Inspect a user'},
    {cmd: '/me [action]', desc: 'Perform a custom emote'},
    {cmd: '/whisper, /tell [User] [Message]', desc: 'Send private message'},
    {cmd: '/reply [Message]', desc: 'Reply to the last whisper'},
    {cmd: '/invite [User]', desc: 'Invite user to the room'},
    ...EMOTE_COMMANDS.map(c => ({
        cmd: c.aliases
            ? `/${c.key}, ${c.aliases.map(a => `/${a}`).join(', ')}`
            : `/${c.key}`,
        desc: c.desc,
    })),
];

// Set of emote commands that do NOT need a space appended after selection
// (they can be sent immediately without arguments)
const noSpaceCommands = new Set([
    '/help',
    ...EMOTE_COMMANDS
        .filter(c => !c.requiresTarget)
        .flatMap(c => [`/${c.key}`, ...(c.aliases ?? []).map(a => `/${a}`)]),
]);

export function commandNeedsSpace(command: string): boolean {
    return !noSpaceCommands.has(command);
}

export type LocalCommand =
    | { kind: 'help' }
    | { kind: 'inspect'; target: string }
    | { kind: 'invite'; target: string }
    | { kind: 'reply'; content: string }
    | { kind: 'error'; error: string }
    | null;

export function getLocalCommand(raw: string): LocalCommand {
    const trimmed = raw.trim();
    const validation = validateCommand(trimmed);

    if (!validation.valid) {
        return {kind: 'error', error: validation.error};
    }

    if (validation.kind === 'help') return {kind: 'help'};

    for (const cmd of ['/inspect ', '/look ', '/finger ']) {
        if (trimmed.startsWith(cmd)) {
            const target = trimmed.slice(cmd.length).trim();
            if (target) return {kind: 'inspect', target};
        }
    }

    if (trimmed.startsWith('/invite ')) {
        const target = trimmed.slice(8).trim();
        if (target) return {kind: 'invite', target};
    }

    if (trimmed.startsWith('/reply ')) {
        return {kind: 'reply', content: trimmed.slice(7)};
    }

    return null;
}

export function isUnknownCommand(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('/')) return false;
    const cmd = trimmed.split(' ')[0].toLowerCase();
    return !SLASH_COMMANDS.includes(cmd);
}

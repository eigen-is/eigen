import {validateCommand} from '../../validation';

export const COMMANDS_HELP = [
    {cmd: '/?, /h, /help', desc: 'List of available slash commands'},
    {cmd: '/time', desc: 'Provides server as well as local time'},
    {cmd: '/inspect, /look, /finger [User]', desc: 'Inspects the user'},
    {cmd: '/dance', desc: 'Performs the dance emote'},
    {cmd: '/cheer', desc: 'Performs the cheer emote'},
    {cmd: '/taunt', desc: 'Performs the taunt emote'},
    {cmd: '/greet', desc: 'Performs the greet emote'},
    {cmd: '/allthethings', desc: 'ALL THE THINGS! \\o/'},
    {cmd: '/facepalm', desc: 'Drags hand down face'},
    {cmd: '/shrug', desc: '¯\\_(ツ)_/¯'},
    {cmd: '/flip', desc: '(╯°□°)╯︵ ┻━┻'},
    {cmd: '/me [action]', desc: 'Performs a custom emote'},
    {cmd: '/i, /inv, /invite [User]', desc: 'Invites user to the room'},
    {cmd: '/send, /t, /tell, /w, /whisper [User] [Message]', desc: 'Send private message'},
    {cmd: '/reply, /r [Message]', desc: 'Reply to the last whisper'},
];

export const SLASH_COMMANDS = [
    '/?', '/h', '/help',
    '/time',
    '/inspect', '/look', '/finger',
    '/dance', '/cheer', '/taunt', '/greet',
    '/allthethings', '/facepalm', '/shrug', '/flip',
    '/me',
    '/i', '/inv', '/invite',
    '/send', '/t', '/tell', '/w', '/whisper',
    '/reply', '/r'
];

export type LocalCommand =
    | { kind: 'help' }
    | { kind: 'time' }
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

    if (validation.kind === 'help') {
        return {kind: 'help'};
    }
    if (validation.kind === 'time') {
        return {kind: 'time'};
    }

    for (const cmd of ['/inspect ', '/look ', '/finger ']) {
        if (trimmed.startsWith(cmd)) {
            const target = trimmed.slice(cmd.length).trim();
            if (target) return {kind: 'inspect', target};
        }
    }

    for (const cmd of ['/invite ', '/i ', '/inv ']) {
        if (trimmed.startsWith(cmd)) {
            const target = trimmed.slice(cmd.length).trim();
            if (target) return {kind: 'invite', target};
        }
    }

    if (trimmed.startsWith('/reply ') || trimmed.startsWith('/r ')) {
        const cmd = trimmed.startsWith('/reply ') ? '/reply ' : '/r ';
        return {kind: 'reply', content: trimmed.slice(cmd.length)};
    }

    return null;
}

export function isUnknownCommand(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('/')) return false;
    const cmd = trimmed.split(' ')[0].toLowerCase();
    return !SLASH_COMMANDS.includes(cmd);
}

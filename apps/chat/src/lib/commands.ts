export const COMMANDS_HELP = [
    {cmd: '/?, /h, /help', desc: 'List of available slash commands'},
    {cmd: '/time', desc: 'Provides server as well as local time'},
    {cmd: '/inspect, /look, /finger [Player]', desc: 'Inspects the player'},
    {cmd: '/dance', desc: 'Performs the dance emote'},
    {cmd: '/cheer', desc: 'Performs the cheer emote'},
    {cmd: '/taunt', desc: 'Performs the taunt emote'},
    {cmd: '/greet', desc: 'Performs the greet emote'},
    {cmd: '/allthethings', desc: 'ALL THE THINGS! \\o/'},
    {cmd: '/facepalm', desc: 'Drags hand down face'},
    {cmd: '/shrug', desc: '¯\\_(ツ)_/¯'},
    {cmd: '/flip', desc: '(╯°□°)╯︵ ┻━┻'},
    {cmd: '/me [action]', desc: 'Performs a custom emote'},
    {cmd: '/i, /inv, /invite [Player]', desc: 'Invites player to the room'},
    {cmd: '/send, /t, /tell, /w, /whisper [Player] [Message]', desc: 'Send private message'},
    {cmd: '/reply, /r [Message]', desc: 'Reply to the last whisper'},
];

export type LocalCommand =
    | { kind: 'help' }
    | { kind: 'time' }
    | { kind: 'inspect'; target: string }
    | { kind: 'invite'; target: string }
    | { kind: 'reply'; content: string }
    | null;

export function getLocalCommand(raw: string): LocalCommand {
    const trimmed = raw.trim();

    if (trimmed === '/?' || trimmed === '/h' || trimmed === '/help') {
        return {kind: 'help'};
    }
    if (trimmed === '/time') {
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

const KNOWN_COMMANDS = [
    '/help', '/h', '/?', '/time',
    '/inspect', '/look', '/finger',
    '/dance', '/cheer', '/taunt', '/greet',
    '/allthethings', '/facepalm', '/shrug', '/flip',
    '/me', '/whisper', '/w', '/tell', '/t', '/send',
    '/reply', '/r', '/invite', '/i', '/inv',
];

export function isUnknownCommand(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('/')) return false;
    const cmd = trimmed.split(' ')[0].toLowerCase();
    return !KNOWN_COMMANDS.includes(cmd);
}

export function isEmailAddress(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function getAtSuggestQuery(text: string): string | null {
    const atIdx = text.lastIndexOf('@');
    if (atIdx === -1) return null;
    const after = text.slice(atIdx + 1);
    if (after.includes(' ')) return null;
    return after;
}

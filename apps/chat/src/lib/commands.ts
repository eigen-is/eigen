export const COMMANDS_HELP = [
    {cmd: '/?, /h, /help', desc: 'List of available slash commands'},
    {cmd: '/time', desc: 'Provides server as well as local time'},
    {cmd: '/inspect [Player]', desc: 'Inspects the player'},
    {cmd: '/dance', desc: 'Performs the dance emote'},
    {cmd: '/cheer', desc: 'Performs the cheer emote'},
    {cmd: '/taunt', desc: 'Performs the taunt emote'},
    {cmd: '/greet', desc: 'Performs the greet emote'},
    {cmd: '/allthethings', desc: 'ALL THE THINGS! ᕕ( ᐛ )ᕗ'},
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
    if (trimmed.startsWith('/inspect ')) {
        const target = trimmed.slice(9).trim();
        if (target) return {kind: 'inspect', target};
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

export function getAtSuggestQuery(text: string): string | null {
    const atIdx = text.lastIndexOf('@');
    if (atIdx === -1) return null;
    const after = text.slice(atIdx + 1);
    if (after.includes(' ')) return null;
    return after;
}

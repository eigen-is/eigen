import {validateEmailTarget} from './email';

export type CommandValidationResult =
    | {
    valid: true;
    kind: 'builtin-emote' | 'emote' | 'whisper' | 'reply' | 'invite' | 'help' | 'time' | 'inspect' | 'trout'
}
    | { valid: false; error: string };

export function validateCommand(raw: string): CommandValidationResult {
    const trimmed = raw.trim();

    if (!trimmed.startsWith('/')) {
        return {valid: false, error: 'Command must start with /'};
    }

    // Built-in emotes (no arguments)
    const builtinEmotes = ['/dance', '/cheer', '/taunt', '/greet', '/allthethings', '/facepalm', '/shrug', '/flip'];
    if (builtinEmotes.includes(trimmed)) {
        return {valid: true, kind: 'builtin-emote'};
    }

    // Help commands
    if (trimmed === '/?' || trimmed === '/h' || trimmed === '/help') {
        return {valid: true, kind: 'help'};
    }

    // Time command
    if (trimmed === '/time') {
        return {valid: true, kind: 'time'};
    }

    // Custom emote: /me [action]
    if (trimmed.startsWith('/me')) {
        if (trimmed === '/me' || trimmed === '/me ') {
            return {valid: false, error: '/me requires an action description'};
        }
        return {valid: true, kind: 'emote'};
    }

    // Whisper commands: /whisper [email] [message]
    for (const cmd of ['/whisper ', '/w ', '/tell ', '/t ', '/send ']) {
        if (trimmed.startsWith(cmd)) {
            const rest = trimmed.slice(cmd.length);
            const spaceIdx = rest.indexOf(' ');
            if (spaceIdx <= 0) {
                return {valid: false, error: `${cmd.trim()} requires email and message`};
            }
            const target = rest.slice(0, spaceIdx).trim();
            const message = rest.slice(spaceIdx + 1).trim();
            if (!message) {
                return {valid: false, error: `${cmd.trim()} requires a message`};
            }
            const emailError = validateEmailTarget(target, 'whisper target');
            if (emailError) {
                return {valid: false, error: emailError};
            }
            return {valid: true, kind: 'whisper'};
        }
    }

    // Check for whisper commands without arguments
    for (const cmd of ['/whisper', '/w', '/tell', '/t', '/send']) {
        if (trimmed === cmd) {
            return {valid: false, error: `${cmd} requires email and message`};
        }
    }

    // Reply commands: /reply [message]
    if (trimmed.startsWith('/reply') || trimmed.startsWith('/r')) {
        if (trimmed === '/reply' || trimmed === '/reply ') {
            return {valid: false, error: '/reply requires a message'};
        }
        if (trimmed === '/r' || trimmed === '/r ') {
            return {valid: false, error: '/r requires a message'};
        }
        return {valid: true, kind: 'reply'};
    }

    // Invite commands: /invite [email]
    for (const cmd of ['/invite ', '/i ', '/inv ']) {
        if (trimmed.startsWith(cmd)) {
            const target = trimmed.slice(cmd.length).trim();
            const emailError = validateEmailTarget(target, 'invite target');
            if (emailError) {
                return {valid: false, error: emailError};
            }
            return {valid: true, kind: 'invite'};
        }
    }

    // Check for invite commands without arguments
    for (const cmd of ['/invite', '/i', '/inv']) {
        if (trimmed === cmd) {
            return {valid: false, error: 'invite target cannot be empty'};
        }
    }

    // Inspect commands: /inspect [email]
    for (const cmd of ['/inspect ', '/look ', '/finger ']) {
        if (trimmed.startsWith(cmd)) {
            const target = trimmed.slice(cmd.length).trim();
            const emailError = validateEmailTarget(target, 'inspect target');
            if (emailError) {
                return {valid: false, error: emailError};
            }
            return {valid: true, kind: 'inspect'};
        }
    }

    // Check for inspect commands without arguments
    for (const cmd of ['/inspect', '/look', '/finger']) {
        if (trimmed === cmd) {
            return {valid: false, error: 'inspect target cannot be empty'};
        }
    }

    // Trout command: /trout [email]
    if (trimmed.startsWith('/trout ')) {
        const target = trimmed.slice(7).trim();
        const emailError = validateEmailTarget(target, 'trout target');
        if (emailError) {
            return {valid: false, error: emailError};
        }
        return {valid: true, kind: 'trout'};
    }
    if (trimmed === '/trout') {
        return {valid: false, error: '/trout requires a target'};
    }

    // Unknown command
    const cmd = trimmed.split(' ')[0];
    return {valid: false, error: `Unknown command: ${cmd}`};
}


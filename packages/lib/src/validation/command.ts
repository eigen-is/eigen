import {validateEmailTarget} from './email';
import {resolveEmoteKey, getEmoteCommand} from '../core/chat/emotes';

export type CommandValidationResult =
    | {
    valid: true;
    kind: 'builtin-emote' | 'emote' | 'whisper' | 'reply' | 'invite' | 'help' | 'inspect'
}
    | { valid: false; error: string };

export function validateCommand(raw: string): CommandValidationResult {
    const trimmed = raw.trim();

    if (!trimmed.startsWith('/')) {
        return {valid: false, error: 'Command must start with /'};
    }

    const spaceIdx = trimmed.indexOf(' ');
    const cmdWord = (spaceIdx > 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1)).toLowerCase();
    const rest = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : '';

    // Help
    if (cmdWord === 'help' && !rest) return {valid: true, kind: 'help'};

    // Built-in emotes (with optional target)
    const emoteKey = resolveEmoteKey(cmdWord);
    if (emoteKey) {
        const cmd = getEmoteCommand(emoteKey);
        if (!cmd) return {valid: false, error: `Unknown emote: /${cmdWord}`};

        if (cmd.requiresTarget && !rest) {
            return {valid: false, error: `/${cmdWord} requires a target`};
        }
        if (rest && !cmd.canTarget && !cmd.requiresTarget) {
            return {valid: false, error: `/${cmdWord} does not accept a target`};
        }
        if (rest) {
            const emailError = validateEmailTarget(rest, 'emote target');
            if (emailError) return {valid: false, error: emailError};
        }
        return {valid: true, kind: 'builtin-emote'};
    }

    // Custom emote: /me [action]
    if (cmdWord === 'me') {
        if (!rest) return {valid: false, error: '/me requires an action description'};
        return {valid: true, kind: 'emote'};
    }

    // Whisper: /whisper|/tell [email] [message]
    if (cmdWord === 'whisper' || cmdWord === 'tell') {
        if (!rest) return {valid: false, error: `/${cmdWord} requires email and message`};
        const si = rest.indexOf(' ');
        if (si <= 0) return {valid: false, error: `/${cmdWord} requires email and message`};
        const target = rest.slice(0, si).trim();
        const message = rest.slice(si + 1).trim();
        if (!message) return {valid: false, error: `/${cmdWord} requires a message`};
        const emailError = validateEmailTarget(target, 'whisper target');
        if (emailError) return {valid: false, error: emailError};
        return {valid: true, kind: 'whisper'};
    }

    // Reply: /reply [message]
    if (cmdWord === 'reply') {
        if (!rest) return {valid: false, error: '/reply requires a message'};
        return {valid: true, kind: 'reply'};
    }

    // Invite: /invite [email]
    if (cmdWord === 'invite') {
        if (!rest) return {valid: false, error: 'invite target cannot be empty'};
        const emailError = validateEmailTarget(rest, 'invite target');
        if (emailError) return {valid: false, error: emailError};
        return {valid: true, kind: 'invite'};
    }

    // Inspect: /inspect|/look|/finger [email]
    if (cmdWord === 'inspect' || cmdWord === 'look' || cmdWord === 'finger') {
        if (!rest) return {valid: false, error: 'inspect target cannot be empty'};
        const emailError = validateEmailTarget(rest, 'inspect target');
        if (emailError) return {valid: false, error: emailError};
        return {valid: true, kind: 'inspect'};
    }

    const cmd = trimmed.split(' ')[0];
    return {valid: false, error: `Unknown command: ${cmd}`};
}

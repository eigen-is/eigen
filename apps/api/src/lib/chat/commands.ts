import { BUILT_IN_EMOTES } from '@workspace/lib/chat/built-in-emotes';
import { resolveEmoteKey } from '@workspace/lib/chat/emotes';
import { validateCommand } from '@workspace/lib/validation';

export type ParsedCommand =
    | { kind: 'emote'; content: string }
    | { kind: 'builtin-emote'; emoteKey: string; target?: string }
    | { kind: 'whisper'; target: string; content: string }
    | { kind: 'error'; error: string };

export function parseCommand(raw: string): ParsedCommand {
    const trimmed = raw.trim();

    const validation = validateCommand(trimmed);
    if (!validation.valid) {
        return { kind: 'error', error: validation.error };
    }

    // Built-in emotes (with optional target)
    const spaceIdx = trimmed.indexOf(' ');
    const cmdWord = (spaceIdx > 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1)).toLowerCase();
    const emoteKey = resolveEmoteKey(cmdWord);

    if (emoteKey) {
        const rest = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : '';
        if (rest) {
            return { kind: 'builtin-emote', emoteKey, target: rest };
        }
        return { kind: 'builtin-emote', emoteKey };
    }

    // Custom emote: /me [action]
    if (trimmed.startsWith('/me ')) {
        return { kind: 'emote', content: trimmed.slice(4) };
    }

    // Whisper commands: /whisper [email] [message]
    for (const cmd of ['/whisper ', '/tell ']) {
        if (trimmed.startsWith(cmd)) {
            const rest = trimmed.slice(cmd.length);
            const si = rest.indexOf(' ');
            if (si > 0) {
                return { kind: 'whisper', target: rest.slice(0, si), content: rest.slice(si + 1) };
            }
        }
    }

    // invite, reply, inspect, help are client-only commands handled by getLocalCommand()
    return { kind: 'error', error: 'Unknown command' };
}

export function formatEmoteForViewer(
    content: string,
    authorEmail: string,
    authorId: string,
    viewerId: string,
    viewerEmail?: string,
): string {
    // Emit full emails; the client renders them as resolved, hoverable display names.
    if (content.startsWith('$')) {
        const raw = content.slice(1);
        const colonIdx = raw.indexOf(':');
        const emoteKey = colonIdx > 0 ? raw.slice(0, colonIdx) : raw;
        const targetEmail = colonIdx > 0 ? raw.slice(colonIdx + 1) : undefined;

        const emote = BUILT_IN_EMOTES[emoteKey];
        if (!emote) return `${authorEmail} does something mysterious.`;

        if (targetEmail) {
            const isAuthor = authorId === viewerId;
            const isTarget = viewerEmail?.toLowerCase() === targetEmail.toLowerCase();

            if (isAuthor)
                return (emote.targetedFirstPerson ?? `You emote at ${targetEmail}.`).replace('{target}', targetEmail);
            if (isTarget)
                return (emote.targetedSecondPerson ?? `${authorEmail} emotes at you.`).replace('{name}', authorEmail);
            return (emote.targetedThirdPerson ?? `${authorEmail} emotes at ${targetEmail}.`)
                .replace('{name}', authorEmail)
                .replace('{target}', targetEmail);
        }

        if (authorId === viewerId) return emote.firstPerson ?? `You do something.`;
        return (emote.thirdPerson ?? `${authorEmail} does something.`).replace('{name}', authorEmail);
    }

    return `${authorEmail} ${content}`;
}

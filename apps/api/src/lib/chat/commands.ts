// The chat commands the server stores as messages, such as a built-in emote, /me and /whisper. A chat post
// runs parseCommand on what the user typed to get the message row. A stored emote is phrased again for
// each reader by formatEmoteForViewer, and searchableMessageText is the text the search indexes keep.

import { BUILT_IN_EMOTES } from '@workspace/lib/chat/built-in-emotes';
import { resolveEmoteKey } from '@workspace/lib/chat/emotes';
import type { ChatMessage } from '@workspace/lib/types/chat';
import { EMAIL_FIND_REGEX, validateCommand } from '@workspace/lib/validation';
import { getUserByEmail } from '../user';

type ParsedCommand =
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
        return rest ? { kind: 'builtin-emote', emoteKey, target: rest } : { kind: 'builtin-emote', emoteKey };
    }

    // Custom emote: /me [action]
    if (trimmed.startsWith('/me ')) {
        return { kind: 'emote', content: trimmed.slice(4) };
    }

    // Whisper commands: /whisper [email] [message]
    for (const cmd of ['/whisper ', '/tell ']) {
        if (trimmed.startsWith(cmd)) {
            const rest = trimmed.slice(cmd.length);
            const targetEnd = rest.indexOf(' ');
            if (targetEnd > 0) {
                return { kind: 'whisper', target: rest.slice(0, targetEnd), content: rest.slice(targetEnd + 1) };
            }
        }
    }

    // Invite, reply, inspect and help run in the browser (getLocalCommand), so they never reach the server.
    return { kind: 'error', error: 'Unknown command' };
}

export function formatEmoteForViewer(content: string, authorEmail: string, viewerEmail?: string): string {
    // The sentence keeps full emails. The chat client shows each one as a name you can hover.
    if (content.startsWith('$')) {
        const raw = content.slice(1);
        const colonIdx = raw.indexOf(':');
        const emoteKey = colonIdx > 0 ? raw.slice(0, colonIdx) : raw;
        const targetEmail = colonIdx > 0 ? raw.slice(colonIdx + 1) : undefined;

        const emote = BUILT_IN_EMOTES[emoteKey];
        if (!emote) return `${authorEmail} does something mysterious.`;

        const isAuthor = viewerEmail?.toLowerCase() === authorEmail.toLowerCase();

        if (targetEmail) {
            const isTarget = viewerEmail?.toLowerCase() === targetEmail.toLowerCase();

            if (isAuthor)
                return (emote.targetedFirstPerson ?? `You emote at ${targetEmail}.`).replace('{target}', targetEmail);
            if (isTarget)
                return (emote.targetedSecondPerson ?? `${authorEmail} emotes at you.`).replace('{name}', authorEmail);
            return (emote.targetedThirdPerson ?? `${authorEmail} emotes at ${targetEmail}.`)
                .replace('{name}', authorEmail)
                .replace('{target}', targetEmail);
        }

        if (isAuthor) return emote.firstPerson ?? `You do something.`;
        return (emote.thirdPerson ?? `${authorEmail} does something.`).replace('{name}', authorEmail);
    }

    return `${authorEmail} ${content}`;
}

// What every search indexes for a stored message: the text a bystander reads. A built-in emote is its
// third-person sentence, not its key. The people an emote names appear by display name, as the chat
// shows them, so a search for a name finds it. Whispers never get here (SEARCHABLE_MESSAGES).
export async function searchableMessageText(
    message: Pick<ChatMessage, 'type' | 'content' | 'authorEmail'>,
): Promise<string> {
    if (message.type !== 'emote') return message.content;
    const sentence = formatEmoteForViewer(message.content, message.authorEmail);
    const names = await Promise.all(
        (sentence.match(EMAIL_FIND_REGEX) ?? []).map(
            async (email) => (await getUserByEmail(email))?.name.trim() || email,
        ),
    );
    return sentence.replace(EMAIL_FIND_REGEX, () => names.shift() ?? '');
}

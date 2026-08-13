import { getEmoteCommand, resolveEmoteKey } from '@workspace/lib/chat';

export function getAtSuggestQuery(text: string): string | null {
    const atIdx = text.lastIndexOf('@');
    if (atIdx === -1) return null;
    if (atIdx > 0) {
        const charBefore = text[atIdx - 1];
        if (!/[\s,.]/.test(charBefore)) return null;
    }
    const after = text.slice(atIdx + 1);
    if (after.includes(' ')) return null;
    return after;
}

export type SlashTargetContext = {
    query: string;
    mode: 'members' | 'contacts';
    appendSpace: boolean;
};

export function getSlashTargetQuery(text: string): SlashTargetContext | null {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith('/')) return null;

    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx <= 0) return null;

    const cmdWord = trimmed.slice(1, spaceIdx).toLowerCase();
    const rest = trimmed.slice(spaceIdx + 1);

    // Emote targets (canTarget or requiresTarget)
    const emoteKey = resolveEmoteKey(cmdWord);
    if (emoteKey) {
        const cmd = getEmoteCommand(emoteKey);
        if (cmd && (cmd.canTarget || cmd.requiresTarget)) {
            if (rest.includes(' ')) return null;
            return { query: rest, mode: 'members', appendSpace: false };
        }
        return null;
    }

    // /invite → contacts not in room
    if (cmdWord === 'invite') {
        if (rest.includes(' ')) return null;
        return { query: rest, mode: 'contacts', appendSpace: false };
    }

    // /whisper, /tell → room members, then continue typing message
    if (cmdWord === 'whisper' || cmdWord === 'tell') {
        if (rest.includes(' ')) return null;
        return { query: rest, mode: 'members', appendSpace: true };
    }

    // /inspect, /look, /finger
    if (cmdWord === 'inspect' || cmdWord === 'look' || cmdWord === 'finger') {
        if (rest.includes(' ')) return null;
        return { query: rest, mode: 'members', appendSpace: false };
    }

    return null;
}

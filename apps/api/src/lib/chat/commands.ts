type EmoteDefinition = {
    firstPerson: string;
    thirdPerson: string;
}

const BUILT_IN_EMOTES: Record<string, EmoteDefinition> = {
    dance: {
        firstPerson: "You dance around the room.",
        thirdPerson: "{name} dances around the room.",
    },
    cheer: {
        firstPerson: "You cheer enthusiastically!",
        thirdPerson: "{name} cheers enthusiastically!",
    },
    taunt: {
        firstPerson: "You taunt everyone in the room.",
        thirdPerson: "{name} taunts everyone in the room.",
    },
    greet: {
        firstPerson: "You greet everyone in the room.",
        thirdPerson: "{name} greets everyone, including you.",
    },
};

export type ParsedCommand =
    | { kind: 'message'; content: string }
    | { kind: 'emote'; content: string }
    | { kind: 'builtin-emote'; emoteKey: string }
    | { kind: 'whisper'; target: string; content: string }
    | { kind: 'reply'; content: string }
    | { kind: 'invite'; target: string };

export function parseCommand(raw: string): ParsedCommand {
    const trimmed = raw.trim();

    if (trimmed === '/dance') return {kind: 'builtin-emote', emoteKey: 'dance'};
    if (trimmed === '/cheer') return {kind: 'builtin-emote', emoteKey: 'cheer'};
    if (trimmed === '/taunt') return {kind: 'builtin-emote', emoteKey: 'taunt'};
    if (trimmed === '/greet') return {kind: 'builtin-emote', emoteKey: 'greet'};

    if (trimmed.startsWith('/me ')) {
        return {kind: 'emote', content: trimmed.slice(4)};
    }

    for (const cmd of ['/whisper ', '/w ', '/tell ', '/t ', '/send ']) {
        if (trimmed.startsWith(cmd)) {
            const rest = trimmed.slice(cmd.length);
            const spaceIdx = rest.indexOf(' ');
            if (spaceIdx > 0) {
                return {kind: 'whisper', target: rest.slice(0, spaceIdx), content: rest.slice(spaceIdx + 1)};
            }
        }
    }

    if (trimmed.startsWith('/reply ') || trimmed.startsWith('/r ')) {
        const cmd = trimmed.startsWith('/reply ') ? '/reply ' : '/r ';
        return {kind: 'reply', content: trimmed.slice(cmd.length)};
    }

    for (const cmd of ['/invite ', '/i ', '/inv ']) {
        if (trimmed.startsWith(cmd)) {
            const target = trimmed.slice(cmd.length).trim();
            if (target) return {kind: 'invite', target};
        }
    }

    return {kind: 'message', content: trimmed};
}

export function formatEmoteForViewer(content: string, authorEmail: string, authorId: string, viewerId: string): string {
    const authorName = authorEmail.split('@')[0] || authorEmail;

    if (content.startsWith('$')) {
        const emoteKey = content.slice(1);
        const emote = BUILT_IN_EMOTES[emoteKey];
        if (!emote) return `${authorName} does something mysterious.`;

        if (authorId === viewerId) {
            return emote.firstPerson;
        }
        return emote.thirdPerson.replace('{name}', authorName);
    }

    return `${authorName} ${content}`;
}

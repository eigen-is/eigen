import {validateCommand} from '@workspace/lib/validation';

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
    allthethings: {
        firstPerson: "You raise your arms dramatically and declare: ALL THE THINGS! \\o/",
        thirdPerson: "{name} raises their arms dramatically and declares: ALL THE THINGS! \\o/",
    },
    facepalm: {
        firstPerson: "You drag your hand slowly down your face.",
        thirdPerson: "{name} drags their hand slowly down their face.",
    },
    shrug: {
        firstPerson: "You shrug. ¯\\_(ツ)_/¯",
        thirdPerson: "{name} shrugs. ¯\\_(ツ)_/¯",
    },
    flip: {
        firstPerson: "You flip the table! (╯°□°)╯︵ ┻━┻",
        thirdPerson: "{name} flips the table! (╯°□°)╯︵ ┻━┻",
    },
};

export type ParsedCommand =
    | { kind: 'message'; content: string }
    | { kind: 'emote'; content: string }
    | { kind: 'builtin-emote'; emoteKey: string }
    | { kind: 'whisper'; target: string; content: string }
    | { kind: 'reply'; content: string }
    | { kind: 'invite'; target: string }
    | { kind: 'error'; error: string };

export function parseCommand(raw: string): ParsedCommand {
    const trimmed = raw.trim();

    // Validate command first
    const validation = validateCommand(trimmed);
    if (!validation.valid) {
        return { kind: 'error', error: validation.error };
    }

    // Built-in emotes
    if (trimmed === '/dance') return {kind: 'builtin-emote', emoteKey: 'dance'};
    if (trimmed === '/cheer') return {kind: 'builtin-emote', emoteKey: 'cheer'};
    if (trimmed === '/taunt') return {kind: 'builtin-emote', emoteKey: 'taunt'};
    if (trimmed === '/greet') return {kind: 'builtin-emote', emoteKey: 'greet'};
    if (trimmed === '/allthethings') return {kind: 'builtin-emote', emoteKey: 'allthethings'};
    if (trimmed === '/facepalm') return {kind: 'builtin-emote', emoteKey: 'facepalm'};
    if (trimmed === '/shrug') return {kind: 'builtin-emote', emoteKey: 'shrug'};
    if (trimmed === '/flip') return {kind: 'builtin-emote', emoteKey: 'flip'};

    // Custom emote: /me [action]
    if (trimmed.startsWith('/me ')) {
        return {kind: 'emote', content: trimmed.slice(4)};
    }

    // Whisper commands: /whisper [email] [message]
    for (const cmd of ['/whisper ', '/w ', '/tell ', '/t ', '/send ']) {
        if (trimmed.startsWith(cmd)) {
            const rest = trimmed.slice(cmd.length);
            const spaceIdx = rest.indexOf(' ');
            if (spaceIdx > 0) {
                return {kind: 'whisper', target: rest.slice(0, spaceIdx), content: rest.slice(spaceIdx + 1)};
            }
        }
    }

    // Reply commands: /reply [message]
    if (trimmed.startsWith('/reply ') || trimmed.startsWith('/r ')) {
        const cmd = trimmed.startsWith('/reply ') ? '/reply ' : '/r ';
        return {kind: 'reply', content: trimmed.slice(cmd.length)};
    }

    // Invite commands: /invite [email]
    for (const cmd of ['/invite ', '/i ', '/inv ']) {
        if (trimmed.startsWith(cmd)) {
            const target = trimmed.slice(cmd.length).trim();
            return {kind: 'invite', target};
        }
    }

    // Should never reach here due to validation
    return {kind: 'error', error: 'Unknown command'};
}

export {isEmailAddress, validateEmailTarget, validateCommand} from '@workspace/lib/validation';

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

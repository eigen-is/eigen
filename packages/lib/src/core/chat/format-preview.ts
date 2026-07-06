import { EMAIL_FIND_REGEX } from '@workspace/lib/validation';
import { BUILT_IN_EMOTES } from './built-in-emotes';

type FormatChatPreviewOpts = {
    resolveName?: (email: string) => string | undefined;
    viewerEmail?: string;
};

// Renders a chat message the way the chat UI does, for activity previews (notification bell,
// SSE toast, drive Recent-activity). Two things the raw wire form leaks: emote syntax
// ($dance:marloes@eigen.is) and bare emails. Emotes become the observer's sentence WITHOUT the
// actor (the surrounding row already names them); emails resolve to display names when a
// resolver is given, else stay raw. Truncation is the caller's concern.
export function formatChatPreview(text: string, opts?: FormatChatPreviewOpts): string {
    let out = text;

    if (text.startsWith('$')) {
        const raw = text.slice(1);
        const colonIdx = raw.indexOf(':');
        const emoteKey = colonIdx > 0 ? raw.slice(0, colonIdx) : raw;
        const targetEmail = colonIdx > 0 ? raw.slice(colonIdx + 1) : undefined;
        const emote = BUILT_IN_EMOTES[emoteKey];

        // Only a resolvable emote key is the wire form; a plain message that merely starts with
        // "$" (e.g. "$5 for coffee") isn't an emote and is left as-is.
        if (emote) {
            let sentence: string;
            if (targetEmail) {
                sentence =
                    opts?.viewerEmail?.toLowerCase() === targetEmail.toLowerCase()
                        ? (emote.targetedSecondPerson ?? '{name} emotes at you.')
                        : (emote.targetedThirdPerson ?? '{name} emotes at {target}.').replace('{target}', targetEmail);
            } else {
                sentence = emote.thirdPerson ?? '{name} does something.';
            }
            // Drop the {name} placeholder — usually a leading "{name} ", occasionally mid-sentence
            // or possessive ("{name}'s" → "their"). The email pass below resolves {target}.
            out = sentence.replace("{name}'s", 'their').replace('{name} ', '').replace('{name}', '');
        }
    }

    const resolve = opts?.resolveName;
    if (resolve) {
        out = out.replace(new RegExp(EMAIL_FIND_REGEX), (email) => resolve(email) ?? email);
    }

    return out;
}

// Single-pass linkifier for plain-text bodies: http(s)/mailto: URLs, bare e-mail addresses, `www.` hosts
// and Bluesky `@handle`s. Bare `example.com` is deliberately not guessed — that needs a TLD list and is
// the most false-positive-prone case.

export type TextLink = { start: number; end: number; href: string };

const DOMAIN = String.raw`(?:[a-z0-9-]+\.)+[a-z]{2,}`;
const URL_CHARS = String.raw`[^\s<>"']`;
const LINK_RE = new RegExp(
    [
        String.raw`(?<url>(?<![\w@])(?:https?://|mailto:)${URL_CHARS}+)`,
        String.raw`(?<email>(?<![\w@.+-])[\w+-]+(?:\.[\w+-]+)*@${DOMAIN})`,
        String.raw`(?<www>(?<![\w@./-])www\.${DOMAIN}(?::\d+)?(?:[/?#]${URL_CHARS}*)?)`,
        String.raw`(?<handle>(?<![\w@])@[a-z0-9_][a-z0-9._-]*[a-z0-9](?!\w))`,
    ].join('|'),
    'gi',
);

const TRAILING_PUNCTUATION = new Set(['.', ',', ':', ';', '!', '?']);
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function count(text: string, char: string): number {
    return text.split(char).length - 1;
}

// Sentence punctuation after a URL is not part of it, nor is a closing bracket that has no opener inside it.
function trimTrailing(text: string): string {
    let end = text.length;
    while (end > 0) {
        const last = text[end - 1] ?? '';
        const opener = CLOSERS[last];
        if (opener !== undefined) {
            if (count(text.slice(0, end), opener) >= count(text.slice(0, end), last)) break;
        } else if (!TRAILING_PUNCTUATION.has(last)) break;
        end--;
    }
    return text.slice(0, end);
}

export function findLinks(text: string): TextLink[] {
    const links: TextLink[] = [];
    for (const match of text.matchAll(LINK_RE)) {
        const { email, www, handle } = match.groups ?? {};
        const linked = trimTrailing(match[0]);
        let href = linked; // http(s):// and mailto: link as written
        if (email) href = `mailto:${linked}`;
        else if (www) href = `http://${linked}`;
        else if (handle) href = `https://bsky.app/profile/${linked.slice(1)}`;
        links.push({ start: match.index, end: match.index + linked.length, href });
    }
    return links;
}

export type SmartInput = { kind: 'email'; value: string } | { kind: 'url'; value: string };

// Strict full-input email shape covering +tags, dots, hyphens. Anchored — partial
// inputs do not match.
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export function parseSmartInput(input: string): SmartInput | null {
    const trimmed = input.trim();
    if (trimmed.length === 0) return null;

    if (EMAIL_RE.test(trimmed)) {
        return { kind: 'email', value: trimmed };
    }

    // URL parse only succeeds when the input is unambiguously a URL — we require an
    // explicit http/https protocol. javascript:, file:, data:, mailto: etc. all parse
    // as valid URLs but are rejected by the protocol allowlist.
    try {
        const url = new URL(trimmed);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
            return { kind: 'url', value: trimmed };
        }
    } catch {
        // not a URL
    }

    return null;
}

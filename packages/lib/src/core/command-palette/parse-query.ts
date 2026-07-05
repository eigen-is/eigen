import type { PaletteScope } from '@workspace/lib/types/command-palette';

export type ParsedQuery = {
    scope?: PaletteScope;
    from?: string;
    to?: string;
    q: string;
};

const SCOPE_PREFIXES: { prefix: string; scope: PaletteScope }[] = [
    { prefix: 'mail:', scope: 'mail' },
    { prefix: 'file:', scope: 'file' },
    { prefix: 'doc:', scope: 'doc' },
    { prefix: '>', scope: 'actions' },
    { prefix: '@', scope: 'contacts' },
    { prefix: '?', scope: 'help' },
];

// Matches `from:<value>` / `to:<value>` where the value runs until the next
// whitespace. The value must be non-empty to count — `from:` with no value falls
// through to plain text. Word-boundary anchored so consecutive operators
// (`from:a to:b`) both match in one pass with the /g flag.
const OPERATOR_RE = /\b(from|to):(\S+)/giu;

export function parseQuery(input: string): ParsedQuery {
    let remaining = input.trim();
    if (remaining.length === 0) return { q: '' };

    let scope: PaletteScope | undefined;
    for (const { prefix, scope: candidate } of SCOPE_PREFIXES) {
        if (remaining.toLowerCase().startsWith(prefix)) {
            scope = candidate;
            remaining = remaining.slice(prefix.length).trimStart();
            break;
        }
    }

    let from: string | undefined;
    let to: string | undefined;
    remaining = remaining.replace(OPERATOR_RE, (_match, name: string, value: string) => {
        if (name.toLowerCase() === 'from') from = value;
        else to = value;
        return '';
    });

    return {
        ...(scope && { scope }),
        ...(from && { from }),
        ...(to && { to }),
        q: remaining.trim().replace(/\s+/g, ' '),
    };
}

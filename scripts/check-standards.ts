// Ratchet the mechanical CODE-STANDARDS rules that Biome can't express.
//
// Two kinds of metric: hard zeros (any hit fails) and ratcheted counts, whose allowance lives in
// scripts/standards-baseline.json. A count may never rise; `--update` rewrites the baseline down to
// what the tree actually has. `--verbose` prints the per-file breakdown. See docs/CODE-STANDARDS.md.

import { LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';
import { createScanner } from 'typescript/unstable/ast/scanner';

const BASELINE_PATH = 'scripts/standards-baseline.json';

const verbose = process.argv.includes('--verbose');
const update = process.argv.includes('--update');

// Non-test, non-generated source. The sheet grammar parser is jison output (biome skips it too).
const GENERATED = ['routeTree.gen.ts', 'packages/sheet/src/engine/parser/grammar-parser/grammar-parser.ts'];
function inScope(path: string): boolean {
    if (!/\.tsx?$/.test(path)) return false;
    if (path.includes('/src/test/')) return false;
    return !(path.endsWith('.d.ts') || /\.test\.tsx?$/.test(path) || GENERATED.some((tail) => path.endsWith(tail)));
}

// The scanner is TypeScript's own (`typescript/unstable/ast`, the one parser-grade surface the 7.x
// package exposes to JS), so escapes, template nesting and comment forms are tokenised, not guessed.
// Two decisions the grammar makes and a lexer cannot: whether a `/` opens a regular expression and
// whether a `<` opens a JSX element. Both hang on the same question — may an expression start here? —
// which the previous token answers: after a closer (`)`, `]`, `}`,
// `++`, `--`), an identifier or a literal an expression is already in hand, so the character divides
// or compares instead. Every other punctuator, and the keywords that take an operand, leave one open.
const CLOSERS = new Set<SyntaxKind>([
    SyntaxKind.CloseParenToken,
    SyntaxKind.CloseBracketToken,
    SyntaxKind.CloseBraceToken,
    SyntaxKind.PlusPlusToken,
    SyntaxKind.MinusMinusToken,
]);
const OPERAND_KEYWORDS = new Set<SyntaxKind>([
    SyntaxKind.AwaitKeyword,
    SyntaxKind.CaseKeyword,
    SyntaxKind.DeleteKeyword,
    SyntaxKind.DoKeyword,
    SyntaxKind.ElseKeyword,
    SyntaxKind.InKeyword,
    SyntaxKind.InstanceOfKeyword,
    SyntaxKind.NewKeyword,
    SyntaxKind.OfKeyword,
    SyntaxKind.ReturnKeyword,
    SyntaxKind.ThrowKeyword,
    SyntaxKind.TypeOfKeyword,
    SyntaxKind.VoidKeyword,
    SyntaxKind.YieldKeyword,
]);

function expressionMayStart(previous: SyntaxKind): boolean {
    if (previous === SyntaxKind.Unknown) return true;
    if (previous >= SyntaxKind.FirstPunctuation && previous <= SyntaxKind.LastPunctuation) {
        return !CLOSERS.has(previous);
    }
    return OPERAND_KEYWORDS.has(previous);
}

// Where the scanner sits: `code` is ordinary TypeScript, `template` a `${…}` substitution (its closing
// brace resumes the literal), `tag` the inside of `<Foo …>`, and `jsx` an element's children.
type Frame = { kind: 'code' | 'template' | 'tag' | 'closing-tag' | 'jsx'; depth: number };

// Blanks out comment bodies, literal contents and JSX text so identifier-shaped metrics never fire on
// prose ("treat it as a secret") or on a string that happens to spell a keyword. Every blanked range
// keeps its length and its newlines, so offsets and line numbers still line up with the source.
function stripNoise(source: string, tsx = false): string {
    const scanner = createScanner(false, tsx ? LanguageVariant.JSX : LanguageVariant.Standard, source);
    const frames: Frame[] = [{ kind: 'code', depth: 0 }];
    const ranges: [number, number][] = [];
    const blank = (start: number, end: number) => {
        if (end > start) ranges.push([start, end]);
    };
    // `scanJsxAttributeValue` reports the `=` before the value as the token's start while its full
    // start is the opening quote, so a literal takes the later of the two; for every other token the
    // full start only reaches back over trivia, which the token start already skips.
    const tokenStart = () => Math.max(scanner.getTokenStart(), scanner.getTokenFullStart());
    // A `<T,>` or `<T extends …>` in .tsx is a type parameter list, the one other thing that may open
    // where an element may. The compiler's parser decides it by lookahead too.
    const opensTypeParameters = () =>
        scanner.lookAhead(() => {
            let token = scanner.scan();
            while (token >= SyntaxKind.FirstTriviaToken && token <= SyntaxKind.LastTriviaToken) token = scanner.scan();
            if (token !== SyntaxKind.Identifier) return false;
            token = scanner.scan();
            while (token >= SyntaxKind.FirstTriviaToken && token <= SyntaxKind.LastTriviaToken) token = scanner.scan();
            return token === SyntaxKind.CommaToken || token === SyntaxKind.ExtendsKeyword;
        });

    let previous = SyntaxKind.Unknown;
    for (;;) {
        const frame = frames[frames.length - 1];
        let token: SyntaxKind;
        if (frame.kind === 'jsx') token = scanner.scanJsxToken();
        else if (frame.kind === 'tag' && previous === SyntaxKind.EqualsToken) token = scanner.scanJsxAttributeValue();
        else token = scanner.scan();
        if (token === SyntaxKind.EndOfFile) break;
        if (token >= SyntaxKind.FirstTriviaToken && token <= SyntaxKind.LastTriviaToken) {
            if (token === SyntaxKind.SingleLineCommentTrivia || token === SyntaxKind.MultiLineCommentTrivia) {
                blank(tokenStart(), scanner.getTokenEnd());
            }
            continue;
        }

        // A slash the grammar reads as a regular expression: rescan it, unless the body runs off the
        // end of the file, which means the guess was wrong and the slash really did divide.
        if (
            (token === SyntaxKind.SlashToken || token === SyntaxKind.SlashEqualsToken) &&
            (frame.kind === 'code' || frame.kind === 'template') &&
            expressionMayStart(previous) &&
            scanner.lookAhead(
                () => scanner.reScanSlashToken() === SyntaxKind.RegularExpressionLiteral && !scanner.isUnterminated(),
            )
        ) {
            token = scanner.reScanSlashToken();
        }

        switch (token) {
            case SyntaxKind.StringLiteral:
            case SyntaxKind.NoSubstitutionTemplateLiteral:
                blank(tokenStart() + 1, scanner.getTokenEnd() - 1);
                break;
            case SyntaxKind.RegularExpressionLiteral:
            case SyntaxKind.JsxText:
            case SyntaxKind.JsxTextAllWhiteSpaces:
                blank(tokenStart(), scanner.getTokenEnd());
                break;
            // `` `head${ `` opens a substitution; the frame it pushes ends on the matching `}`.
            case SyntaxKind.TemplateHead:
                blank(tokenStart() + 1, scanner.getTokenEnd() - 2);
                frames.push({ kind: 'template', depth: 0 });
                break;
            case SyntaxKind.OpenBraceToken:
                if (frame.kind === 'tag' || frame.kind === 'jsx') frames.push({ kind: 'code', depth: 0 });
                else frame.depth++;
                break;
            case SyntaxKind.CloseBraceToken:
                if (frame.depth > 0) frame.depth--;
                else if (frame.kind === 'template') {
                    token = scanner.reScanTemplateToken(false);
                    const tail = token === SyntaxKind.TemplateTail;
                    blank(tokenStart() + 1, scanner.getTokenEnd() - (tail ? 1 : 2));
                    if (tail) frames.pop();
                } else if (frames.length > 1) frames.pop();
                break;
            case SyntaxKind.LessThanToken:
                if (frame.kind === 'jsx') frames.push({ kind: 'tag', depth: 0 });
                else if (tsx && frame.kind !== 'tag' && expressionMayStart(previous) && !opensTypeParameters()) {
                    frames.push({ kind: 'tag', depth: 0 });
                }
                break;
            case SyntaxKind.LessThanSlashToken:
                frames.pop();
                frames.push({ kind: 'closing-tag', depth: 0 });
                break;
            case SyntaxKind.GreaterThanToken:
                if (frame.kind === 'closing-tag') frames.pop();
                else if (frame.kind === 'tag') {
                    frames.pop();
                    // `/>` closes the element outright; a bare `>` opens its children.
                    if (previous !== SyntaxKind.SlashToken) frames.push({ kind: 'jsx', depth: 0 });
                }
                break;
        }
        previous = token;
    }

    let out = '';
    let cursor = 0;
    for (const [start, end] of ranges) {
        out += source.slice(cursor, start) + source.slice(start, end).replaceAll(/[^\n]/g, ' ');
        cursor = end;
    }
    return out + source.slice(cursor);
}

// `as` also renames in module statements, so drop those before counting casts.
// stripNoise blanks a specifier's contents, so it reads as quotes around spaces; a module statement
// holds no `;` or `=`.
const MODULE_STATEMENT =
    /(?:^|\n)[ \t]*(?:import|export)\b[^;=]*?from[ \t]*(?:'[^'\n]*'|"[^"\n]*")|(?:^|\n)[ \t]*import[ \t]*(?:'[^'\n]*'|"[^"\n]*")|(?:^|\n)[ \t]*export[ \t]*\{[^}=;]*\}/g;
const DEEP_IMPORT = /@workspace\/(?:lib\/core\/|lib\/src\/|ui\/src\/)|['"]@workspace\/[\w@./-]+\.tsx?['"]/g;
// Tailwind's default palette — theme tokens replace every one of these (CODE-STANDARDS § Code Style).
const PALETTE =
    'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const RAW_COLOR = new RegExp(
    `\\b(?:text|bg|border|ring|fill|stroke|from|via|to|divide|outline|decoration|accent|caret|placeholder|shadow)-(?:${PALETTE})-(?:50|\\d00|950)\\b`,
    'g',
);
const APP_LAYER = /\b(?:useQuery|useMutation|useInfiniteQuery)\(|\btoast\.(?:error|success)\(/g;

// Every Eigen document MIME, read from the one file that declares them so a seventh type never needs a
// second list here. `application/eigen-*` — the drag and clipboard wire formats — is a different family,
// not a document MIME, hence the `(?!-)`.
const MIME_SOURCE = 'packages/lib/src/types/drive.ts';
const EIGEN_MIME = /application\/eigen(?!-)[a-z]*/g;
const CANONICAL_MIMES = new Set(
    [...(await Bun.file(MIME_SOURCE).text()).matchAll(/DRIVE_MIME_\w+ = '(application\/eigen[a-z]*)'/g)].map(
        (match) => match[1],
    ),
);
if (CANONICAL_MIMES.size === 0) {
    console.error(`ERROR: no DRIVE_MIME_* constants found in ${MIME_SOURCE} — the mime gate has nothing to check`);
    process.exit(1);
}

const ROUTE_FILE = /^apps\/api\/src\/routes\/[^/]+\.ts$/;
// The home-independent surfaces that deliberately carry no `:ownerId` (docs/ARCHITECTURE.md § Pitfalls):
// first-run setup, server-wide admin config, the unauthenticated public surface, and the admin backup
// routes — server-wide too, gated by `requireAdmin` in every handler rather than by home ownership.
const OWNER_ID_EXEMPT = new Set(['setup.ts', 'settings.ts', 'waitlist.ts', 'public.ts', 'backup.ts']);
// One chunk per route: from its `.method('/…` to the next one.
const ROUTE_START = /\.(?:get|post|put|patch|delete|ws|head|options|all)\(\s*['"]\//;
// `/ws` is a transport prefix rather than a path segment — the collab socket's `:ownerId` sits behind it.
const TRANSPORT_PREFIX = /^\/ws(?=\/)/;

// docs/LAYOUT.md § Hover-Only Icons: an affordance hidden until hover must rest visible on touch, which has
// no hover. Only a hidden element is at risk — a decorative `group-hover:scale-105` reveals nothing —
// so the trigger is a hiding utility plus a revealing `group-hover:` in the same class string.
// `pointer-fine:group-hover:` declares the hover desktop-only on purpose and is not a gap.
const STRING_LITERAL = /'[^'\n]*'|"[^"\n]*"|`[^`]*`/g;
const HIDDEN_BASE = /(?<![\w-])(?:invisible|hidden|opacity-0)(?![\w-])/;
const HOVER_REVEAL =
    /(?<!pointer-fine:)\bgroup-hover:(visible|flex|grid|block|inline-flex|inline-block|opacity-\d+)(?![\w-])/g;

type SourceFile = {
    path: string;
    // Raw file text — use it for anything that lives in a comment, a string, or a class name.
    text: string;
    // Comments and literal contents blanked out — use it for anything identifier-shaped.
    code: string;
};

type Metric = {
    id: string;
    label: string;
    hardZero: boolean;
    count: (file: SourceFile) => number;
};

function countMatches(source: string, pattern: RegExp): number {
    return source.match(pattern)?.length ?? 0;
}

const METRICS: Metric[] = [
    {
        id: 'as-casts',
        label: '`as Type` casts',
        hardZero: false,
        // `as unknown as T` is one escape hatch, not two.
        count: ({ code }) =>
            countMatches(
                code.replaceAll(MODULE_STATEMENT, '').replaceAll(/\bas\s+unknown\s+as\b/g, 'as'),
                /\bas\s+(?!const\b)/g,
            ),
    },
    {
        id: 'interface-decls',
        label: '`interface` declarations',
        hardZero: false,
        // Module augmentation only merges through interfaces, so those don't count.
        count: ({ code }) => {
            let depth = 0;
            let augmenting = 0;
            let hits = 0;
            for (const line of code.split('\n')) {
                if (augmenting === 0 && /^\s*declare\s+module\b/.test(line)) augmenting = depth + 1;
                else if (augmenting === 0 && /^\s*(?:export\s+)?(?:declare\s+)?interface\s/.test(line)) hits++;
                depth += countMatches(line, /\{/g) - countMatches(line, /\}/g);
                if (augmenting > 0 && depth < augmenting) augmenting = 0;
            }
            return hits;
        },
    },
    {
        id: 'biome-ignore',
        label: '`biome-ignore` suppressions',
        hardZero: false,
        count: ({ text }) => countMatches(text, /biome-ignore/g),
    },
    {
        id: 'jsdoc-blocks',
        label: 'JSDoc blocks',
        hardZero: false,
        count: ({ text }) => countMatches(text, /^[ \t]*\/\*\*/gm),
    },
    {
        id: 'raw-colors',
        label: 'Raw Tailwind color utilities',
        hardZero: false,
        count: ({ path, text }) => (path.endsWith('.tsx') ? countMatches(text, RAW_COLOR) : 0),
    },
    {
        id: 'use-client',
        label: '`"use client"` directives',
        hardZero: true,
        count: ({ text }) => countMatches(text, /^\s*['"]use client['"]/gm),
    },
    {
        id: 'deep-imports',
        label: 'Imports reaching past a package barrel',
        hardZero: true,
        count: ({ text }) => countMatches(text, DEEP_IMPORT),
    },
    {
        id: 'barrel-type-exports',
        label: 'Type re-exports from a lib core barrel',
        hardZero: true,
        count: ({ path, code }) =>
            /^packages\/lib\/src\/core\/.*index\.ts$/.test(path) ? countMatches(code, /^\s*export\s+type\b/gm) : 0,
    },
    {
        id: 'app-layer',
        label: 'Query/mutation/toast calls in app components',
        hardZero: true,
        // Data fetching and error toasts belong in packages/lib hooks, never in an app component.
        count: ({ path, code }) =>
            /^apps\/(?!api\/)[^/]+\/src\//.test(path) && !path.includes('/hooks/') ? countMatches(code, APP_LAYER) : 0,
    },
    {
        id: 'wrong-eigen-mime',
        label: 'Non-canonical `application/eigen…` MIMEs',
        hardZero: true,
        // `eigenslide` for `eigenslides` and `eigensheet` for `eigensheets` are the typos this catches.
        count: ({ text }) => (text.match(EIGEN_MIME) ?? []).filter((mime) => !CANONICAL_MIMES.has(mime)).length,
    },
    {
        id: 'route-owner-id',
        label: 'Authenticated routes without `:ownerId` second',
        hardZero: true,
        // `ownerId` names the Home that owns the resource, which is the future sharding key.
        count: ({ path, text }) => {
            if (!ROUTE_FILE.test(path) || OWNER_ID_EXEMPT.has(path.slice(path.lastIndexOf('/') + 1))) return 0;
            let hits = 0;
            for (const chunk of text.split(new RegExp(`(?=${ROUTE_START.source})`)).slice(1)) {
                const route = /['"](\/[^'"]*)['"]/.exec(chunk)?.[1];
                // `auth: true` is this route's own option object; an unauthenticated route (LMTP
                // delivery, guest OTP) answers to no Home and is skipped. Comments don't count.
                if (route === undefined || !/auth:\s*true/.test(stripNoise(chunk))) continue;
                if (route.replace(TRANSPORT_PREFIX, '').split('/')[2] !== ':ownerId') hits++;
            }
            return hits;
        },
    },
    {
        id: 'hover-without-touch',
        label: 'Hover-revealed affordances without touch',
        hardZero: true,
        count: ({ text }) => {
            let hits = 0;
            for (const literal of text.match(STRING_LITERAL) ?? []) {
                if (!HIDDEN_BASE.test(literal)) continue;
                for (const [, utility] of literal.matchAll(HOVER_REVEAL)) {
                    if (!text.includes(`pointer-coarse:${utility}`)) hits++;
                }
            }
            return hits;
        },
    },
];

const paths = (await Bun.$`git ls-files apps packages`.text()).split('\n').filter(inScope);

const counts = new Map<string, number>(METRICS.map((metric) => [metric.id, 0]));
const breakdown = new Map<string, Map<string, number>>(METRICS.map((metric) => [metric.id, new Map()]));

for (const path of paths) {
    const text = await Bun.file(path).text();
    const file: SourceFile = { path, text, code: stripNoise(text, path.endsWith('.tsx')) };
    for (const metric of METRICS) {
        const hits = metric.count(file);
        if (hits === 0) continue;
        counts.set(metric.id, (counts.get(metric.id) ?? 0) + hits);
        breakdown.get(metric.id)?.set(path, hits);
    }
}

const baselineFile = Bun.file(BASELINE_PATH);
const baseline: Record<string, number> = (await baselineFile.exists()) ? await baselineFile.json() : {};

if (update) {
    const next: Record<string, number> = {};
    for (const metric of METRICS) {
        if (metric.hardZero) continue;
        const current = counts.get(metric.id) ?? 0;
        next[metric.id] = metric.id in baseline ? Math.min(current, baseline[metric.id]) : current;
    }
    await Bun.write(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    Object.assign(baseline, next);
    console.log(`Updated ${BASELINE_PATH}\n`);
}

const width = Math.max(...METRICS.map((metric) => metric.label.length));
const failed: Metric[] = [];

console.log(`${'metric'.padEnd(width)}  count  baseline`);
for (const metric of METRICS) {
    const count = counts.get(metric.id) ?? 0;
    const allowed = metric.hardZero ? 0 : (baseline[metric.id] ?? 0);
    if (count > allowed) failed.push(metric);
    const status = count > allowed ? '  OVER' : count < allowed ? '  under baseline' : '';
    console.log(
        `${metric.label.padEnd(width)}  ${String(count).padStart(5)}  ${metric.hardZero ? '    zero' : String(allowed).padStart(8)}${status}`,
    );
    if (!verbose) continue;
    for (const [path, hits] of [...(breakdown.get(metric.id) ?? [])].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(hits).padStart(4)}  ${path}`);
    }
}

if (failed.length === 0) process.exit(0);

console.error('\nERROR: code-standards gate exceeded\n');
for (const metric of failed) {
    console.error(
        `  ${metric.label}: ${counts.get(metric.id)} allowed ${metric.hardZero ? 0 : (baseline[metric.id] ?? 0)}`,
    );
    for (const [path, hits] of [...(breakdown.get(metric.id) ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
        console.error(`      ${String(hits).padStart(4)}  ${path}`);
    }
}
console.error('\nSee docs/CODE-STANDARDS.md § Standards gates. Run with --verbose for the full breakdown.');
process.exit(1);

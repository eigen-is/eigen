import eigenProseCSSRaw from '@workspace/ui/styles/eigen-prose.css' with { type: 'text' };
import fontWeightsCSSRaw from '@workspace/ui/styles/font-weights.css' with { type: 'text' };
import { FONT_STACK_MONO, FONT_STACK_SANS } from '../font-stacks';

// eigen-prose.css, flattened once: the HTML and PDF exports embed it, and the docx writer reads
// its sizes, spacing and colors through proseValue, so the editor's look lives in one file.

// The app's weight scale, rounded: WeasyPrint drops any font-weight that is not a multiple of 100.
const FONT_WEIGHTS = new Map(
    [...fontWeightsCSSRaw.matchAll(/(--font-weight-[\w-]+):\s*(\d+);/g)].map(([, name, weight]) => [
        name,
        String(Math.round(Number(weight) / 100) * 100),
    ]),
);

// A comma outside parentheses, so `:is(h1, h2)` stays one item.
const SELECTOR_LIST_COMMA = /,(?![^(]*\))/;

export const PROSE_CSS = flattenEigenProseCSS(eigenProseCSSRaw);

const PROSE_RULES = parseRules(PROSE_CSS);

export function proseValue(selector: string, property: string): string {
    const value = PROSE_RULES.get(selector)?.get(property);
    if (value === undefined) throw new Error(`eigen-prose.css sets no ${property} on ${selector}`);
    return value;
}

// ── CSS flattening ──────────────────────────────────────────────────────────
// The source eigen-prose.css uses modern CSS nesting (.eigen-prose { h1 { … } }).
// Standalone HTML and WeasyPrint need flat CSS, so we rewrite at init time.

function flattenEigenProseCSS(raw: string): string {
    let css = raw.replace(/\s*\/\*[\s\S]*?\*\//g, '').replace(/\.eigen-prose,\s*\n\s*\.tiptap\s*\{/g, '.eigen-prose {');

    // Drop .dark overrides (export is always light)
    css = css.replace(/^\.dark\s+\.eigen-prose[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/gm, '');

    // Flatten CSS nesting for all top-level blocks
    css = css.replace(/^(\.[a-zA-Z][\w-]*)\s*\{([\s\S]*?)^\}/gm, (_match, selector, body) => {
        if (body.includes('{')) {
            return flattenNestedBlock(selector, body);
        }
        return `${selector} {${body}}`;
    });

    // Resolve CSS variables to concrete values
    css = css
        .replace(/var\(--font-sans\)/g, FONT_STACK_SANS)
        .replace(/var\(--font-mono\)/g, FONT_STACK_MONO)
        .replace(/var\(--color-muted-foreground\)/g, '#6b7280')
        .replace(/var\(--color-primary\)/g, '#2563eb')
        .replace(/var\(--color-link,\s*#2563eb\)/g, '#2563eb')
        .replace(/var\(--color-selected\)/g, '#bfdbfe')
        .replace(/var\((--font-weight-[\w-]+)\)/g, (match, name: string) => FONT_WEIGHTS.get(name) ?? match);

    return css;
}

function flattenNestedBlock(parentSelector: string, body: string): string {
    const results: string[] = [];
    let depth = 0;
    let current = '';
    let inNested = false;
    let nestedSelector = '';

    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === '{') {
            if (depth === 0) {
                nestedSelector = current.trim();
                current = '';
                inNested = true;
            } else {
                current += ch;
            }
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0 && inNested) {
                const selectors = nestedSelector.split(SELECTOR_LIST_COMMA).map((item) => {
                    const selector = item.trim();
                    return selector.includes('&')
                        ? selector.replace(/&/g, parentSelector)
                        : `${parentSelector} ${selector}`;
                });
                results.push(`${selectors.join(', ')} { ${current.trim()} }`);
                current = '';
                inNested = false;
                nestedSelector = '';
            } else {
                current += ch;
            }
        } else {
            current += ch;
        }
    }

    const topLevelProps = current.trim();
    if (topLevelProps) {
        results.unshift(`${parentSelector} { ${topLevelProps} }`);
    }

    return results.join('\n');
}

// Screen rules only: the print block hides editor chrome, which no export reads a value from.
function parseRules(css: string): Map<string, Map<string, string>> {
    const rules = new Map<string, Map<string, string>>();
    const screenCSS = css.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
    for (const [, selectorList, body] of screenCSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const item of selectorList.split(SELECTOR_LIST_COMMA)) {
            const selector = item.trim().replace(/\s+/g, ' ');
            const declarations = rules.get(selector) ?? new Map<string, string>();
            for (const declaration of body.split(';')) {
                const colon = declaration.indexOf(':');
                if (colon > 0)
                    declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
            }
            rules.set(selector, declarations);
        }
    }
    return rules;
}

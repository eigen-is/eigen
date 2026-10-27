// The backend's one highlighter, so a language the docx writer writes is one its reader knows, and the HTML, the docx
// and a code file's preview highlight alike. Loading it loads every grammar. The doc schema is built on it, so the API
// loads them all at startup.

import { escapeHtml } from '@workspace/lib/html';
import { common, createLowlight } from 'lowlight';

export const lowlight = createLowlight(common);

export type HastNode = {
    type: string;
    children?: HastNode[];
    value?: string;
    tagName?: string;
    properties?: { className?: string[] };
};

export type CodeHighlighter = (language: string, code: string) => HastNode;

// highlightAuto tries every grammar, about 37. A peer's megabytes of code would otherwise take tens of seconds of every
// export and preview, whether they sit in one block or in a hundred.
const MAX_AUTO_HIGHLIGHT = 64 * 1024;

// One render's highlighter. Users rarely set a language, so highlightAuto is where nearly all export highlighting comes
// from. The render's code with no language it knows shares one budget of characters. From the block that passes it,
// every such block is plain text, as the spent count only grows.
export function codeHighlighter(): CodeHighlighter {
    let autoSpent = 0;
    return (language, code) => {
        if (language && lowlight.registered(language)) return lowlight.highlight(language, code);
        autoSpent += code.length;
        if (autoSpent > MAX_AUTO_HIGHLIGHT) return { type: 'root', children: [{ type: 'text', value: code }] };
        return lowlight.highlightAuto(code);
    };
}

export function hastToHtml(tree: HastNode): string {
    if (tree.type === 'text') return escapeHtml(tree.value || '');
    if (tree.type === 'element' && tree.tagName) {
        const cls = tree.properties?.className;
        const classAttr = cls ? ` class="${cls.join(' ')}"` : '';
        const children = (tree.children || []).map(hastToHtml).join('');
        return `<${tree.tagName}${classAttr}>${children}</${tree.tagName}>`;
    }
    if (tree.type === 'root' && tree.children) {
        return tree.children.map(hastToHtml).join('');
    }
    return '';
}

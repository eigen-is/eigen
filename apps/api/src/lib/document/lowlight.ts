// The backend's one highlighter, so a language the docx writer writes is one its reader knows, and the HTML, the docx
// and a code file's preview highlight alike. Loading it loads every grammar, so the main thread imports it only
// lazily, through what highlights.

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

// highlightAuto tries every grammar, about 37, so a code block past this many characters with no language it knows is
// plain text: a peer's megabytes would otherwise take tens of seconds of every export and preview.
const MAX_AUTO_HIGHLIGHT = 64 * 1024;

// Users rarely set a language, so highlightAuto is where nearly all export highlighting comes from.
export function highlightCode(language: string, code: string): HastNode {
    if (language && lowlight.registered(language)) return lowlight.highlight(language, code);
    if (code.length > MAX_AUTO_HIGHLIGHT) return { type: 'root', children: [{ type: 'text', value: code }] };
    return lowlight.highlightAuto(code);
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

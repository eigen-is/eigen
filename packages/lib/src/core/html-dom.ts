// The HTML helpers that need a browser DOM: plain text of pasted HTML, its alignment, and the sanitizer that
// maps pasted or peer-written HTML onto the LightEditor's tags, such as a comment card's description. They use
// `document`, so code the backend imports never imports this module; the helpers that run anywhere sit beside it.

import type { TextAlign } from '../vector/types';
import { TEXT_ALIGNS } from '../vector/types';
import type { LIGHT_EDITOR_MARK_TAGS } from './html';
import { isElement, LIGHT_EDITOR_BLOCK_TAGS, LIGHT_EDITOR_HREF, RAW_TEXT_DROP_TAGS } from './html';

export function htmlToPlainText(html: string): string {
    // Untrusted clipboard HTML in a detached element still loads images and fires their onerror handlers, so it
    // goes into an inert parsed document instead.
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body.textContent ?? '';
}

// The tags of ./html's shared LightEditor set, matched here on the uppercase DOM tagName. Everything
// else is unwrapped (children preserved) or dropped, so pasted rich HTML converges to that schema.
const BLOCK_TAGS = new Set<string>(LIGHT_EDITOR_BLOCK_TAGS.map((tag) => tag.toUpperCase()));
// Inline marks → their canonical element, so the stored HTML is born the way Tiptap re-serializes it
// (b→strong, i→em, del/strike→s) and a first edit is a no-op rather than a spurious diff.
const MARK_TAG_CANON: Record<string, (typeof LIGHT_EDITOR_MARK_TAGS)[number]> = {
    STRONG: 'strong',
    B: 'strong',
    EM: 'em',
    I: 'em',
    U: 'u',
    S: 's',
    DEL: 's',
    STRIKE: 's',
};
const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
// Elements whose text is code or markup, so their content goes with them instead of unwrapping.
const DROP_TAGS = new Set(
    [...RAW_TEXT_DROP_TAGS, 'object', 'embed', 'template', 'head'].map((tag) => tag.toUpperCase()),
);

// An unsafe href unwraps the anchor to its text.
function safeHref(href: string | null): string | null {
    if (!href) return null;
    const trimmed = href.trim();
    return LIGHT_EDITOR_HREF.test(trimmed) ? trimmed : null;
}

// A card description carries Tiptap task lists, ul > li > label > input plus a content div. Each of those tags
// survives only in its own place, tracked by `taskCtx`, so one outside a task item still unwraps.
type TaskCtx = 'list' | 'item' | 'label';
type SanitizeOptions = { taskList?: boolean; taskCtx?: TaskCtx };

function appendTaskListNode(el: Element, parent: HTMLElement, opts: SanitizeOptions): boolean {
    const tag = el.tagName;
    const recurse = (target: HTMLElement, taskCtx: TaskCtx | undefined) => {
        for (const child of Array.from(el.childNodes)) appendSanitized(child, target, { ...opts, taskCtx });
    };
    // A task list may appear anywhere in prose; its items and their inner structure survive only inside it.
    if (tag === 'UL' && el.getAttribute('data-type') === 'taskList') {
        const ul = document.createElement('ul');
        ul.setAttribute('data-type', 'taskList');
        recurse(ul, 'list');
        parent.appendChild(ul);
        return true;
    }
    if (tag === 'LI' && opts.taskCtx === 'list' && el.hasAttribute('data-checked')) {
        const li = document.createElement('li');
        li.setAttribute('data-checked', el.getAttribute('data-checked') === 'true' ? 'true' : 'false');
        li.setAttribute('data-type', 'taskItem');
        recurse(li, 'item');
        parent.appendChild(li);
        return true;
    }
    if (tag === 'LABEL' && opts.taskCtx === 'item') {
        const label = document.createElement('label');
        recurse(label, 'label');
        parent.appendChild(label);
        return true;
    }
    if (tag === 'INPUT' && opts.taskCtx === 'label') {
        // Forced to a checkbox with no other attribute: an onfocus/autofocus/value never survives.
        const input = document.createElement('input');
        input.setAttribute('type', 'checkbox');
        if (el.hasAttribute('checked')) input.setAttribute('checked', '');
        parent.appendChild(input);
        return true;
    }
    if (tag === 'DIV' && opts.taskCtx === 'item') {
        const div = document.createElement('div');
        recurse(div, undefined);
        parent.appendChild(div);
        return true;
    }
    return false;
}

function appendSanitized(node: Node, parent: HTMLElement, opts: SanitizeOptions): void {
    if (node.nodeType === Node.TEXT_NODE) {
        parent.appendChild(document.createTextNode(node.textContent ?? ''));
        return;
    }
    if (!isElement(node)) return;
    const tag = node.tagName;

    if (DROP_TAGS.has(tag)) return;
    if (tag === 'BR') {
        parent.appendChild(document.createElement('br'));
        return;
    }
    const recurseInto = (target: HTMLElement) => {
        for (const child of Array.from(node.childNodes)) appendSanitized(child, target, opts);
    };
    if (opts.taskList && appendTaskListNode(node, parent, opts)) return;
    // Headings collapse to paragraphs (LightEditor has no heading node).
    if (HEADING_TAGS.has(tag)) {
        const p = document.createElement('p');
        recurseInto(p);
        parent.appendChild(p);
        return;
    }
    if (BLOCK_TAGS.has(tag)) {
        const clean = document.createElement(tag.toLowerCase());
        recurseInto(clean);
        parent.appendChild(clean);
        return;
    }
    const markTag = MARK_TAG_CANON[tag];
    if (markTag) {
        const clean = document.createElement(markTag);
        recurseInto(clean);
        parent.appendChild(clean);
        return;
    }
    if (tag === 'A') {
        const href = safeHref(node.getAttribute('href'));
        if (href) {
            const clean = document.createElement('a');
            // Forced, never trusted from the source: a link navigating in place would take a presenter out of
            // their deck. Tiptap's own attribute order, so the first keystroke rewrites nothing.
            clean.setAttribute('target', '_blank');
            clean.setAttribute('rel', 'noopener noreferrer');
            clean.setAttribute('href', href);
            recurseInto(clean);
            parent.appendChild(clean);
            return;
        }
    }
    // Any other element, such as a span or an unsafe link, unwraps to its children, and no attribute is copied.
    for (const child of Array.from(node.childNodes)) appendSanitized(child, parent, opts);
}

// The alignment of prose pasted from docs into a slide or drawing, read off the raw HTML because the sanitizer
// strips the style that carries it. A left paragraph has no style, so null leaves the caller's default.
export function readDominantTextAlign(html: string): TextAlign | null {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const el of Array.from(doc.body.children)) {
        if (!(el instanceof HTMLElement)) continue;
        const raw = (el.style.textAlign || el.getAttribute('align') || '').trim().toLowerCase();
        const match = TEXT_ALIGNS.find((a) => a === raw);
        if (match) return match;
    }
    return null;
}

// Pasted HTML on the LightEditor's tags: headings become paragraphs, the rest unwraps or drops, and only a safe
// link keeps an attribute. Nothing left gives '', and the caller pastes plain text.
export function sanitizeToLightEditorHtml(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = document.createElement('div');
    for (const child of Array.from(doc.body.childNodes)) appendSanitized(child, out, {});
    return out.innerHTML;
}

// The same tags plus task lists, for a card description, which reaches every viewer verbatim from a peer's
// Yjs edit and renders as raw HTML.
export function sanitizeCommentCardHtml(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = document.createElement('div');
    for (const child of Array.from(doc.body.childNodes)) appendSanitized(child, out, { taskList: true });
    return out.innerHTML;
}

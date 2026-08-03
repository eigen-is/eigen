import type { JSONContent } from '@tiptap/core';
import { renderToHTMLString } from '@tiptap/static-renderer/pm/html-string';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import { escapeHtml } from '@workspace/lib/html';
// CSS embedded as string at build time by Bun's bundler — no runtime file resolution needed
import eigenProseCSSRaw from '@workspace/ui/styles/eigen-prose.css' with { type: 'text' };
import { common, createLowlight } from 'lowlight';
import type * as Y from 'yjs';
import { readEigendocFromDoc } from '../../document/doc';
import { toDataUriMap } from '../../document/media';
import { type ExportMedia, type TransformWarning, toTransferableBuffer } from '../../document/transform/protocol';
import { getFontCSS } from '../fonts';
import { sanitizeExportHtml } from '../sanitize';
import { renderCodeBlockNode, renderFigureNode, renderTaskItemNode } from './render';

// Materialized doc + prepared media → export bytes. Runs inside the transform Worker
// (worker.ts owns execution; the main-thread wrappers live in doc/{html,pdf,docx}.ts).
// This module must not reach the Mount or the preview cache — the Worker imports it.
//
// html and pdf-html are the same document by design: WeasyPrint renders exactly what
// the HTML download serves, so the format only decides what the main thread does with
// the bytes.
export function renderEigendocExport(
    doc: Y.Doc,
    title: string,
    media: ExportMedia[],
): { data: ArrayBuffer; warnings: TransformWarning[] } {
    const html = renderEigendocDocument(readEigendocFromDoc(doc), toDataUriMap(media), title);
    return { data: toTransferableBuffer(new TextEncoder().encode(html)), warnings: [] };
}

const lowlight = createLowlight(common);
const extensions = getDocExtensions({ lowlight });

// Lazy-initialized cached assets
let _proseCSS: string | undefined;

function getProseCSS() {
    return (_proseCSS ??= flattenEigenProseCSS(eigenProseCSSRaw as string));
}

function renderEigendocDocument(json: JSONContent, dataUriMap: Map<string, string>, title: string): string {
    const bodyHtml = renderToHTMLString({
        content: json,
        extensions,
        options: {
            nodeMapping: {
                codeBlock: ({ node }) => renderCodeBlockNode(node, lowlight),
                taskItem: ({ node, children }) => renderTaskItemNode(node, children),
                figure: ({ node }: { node: { attrs: Record<string, unknown> } }) =>
                    renderFigureNode(node.attrs, (mediaName, src) =>
                        mediaName ? (dataUriMap.get(mediaName) ?? null) : src,
                    ),
            },
        },
    });

    return wrapInDocument(title, sanitizeExportHtml(bodyHtml, { ADD_DATA_URI_TAGS: ['img'] }));
}

function wrapInDocument(title: string, bodyHtml: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <style>${getFontCSS()}${getProseCSS()}${PRINT_EXTRAS}</style>
</head>
<body>
    <div class="page">
        <article class="eigen-prose tiptap">
            ${bodyHtml}
        </article>
    </div>
</body>
</html>`;
}

// ── CSS flattening ──────────────────────────────────────────────────────────
// The source eigen-prose.css uses modern CSS nesting (.eigen-prose { h1 { … } }).
// Standalone HTML and WeasyPrint need flat CSS, so we rewrite at init time.

function flattenEigenProseCSS(raw: string): string {
    let css = raw.replace(/\.eigen-prose,\s*\n\s*\.tiptap\s*\{/g, '.eigen-prose {');

    // Drop .dark overrides (export is always light)
    css = css.replace(/^\.dark\s+\.eigen-prose\s*\{[^}]*(?:\{[^}]*\}[^}]*)*\}/gm, '');

    // Flatten CSS nesting for all top-level blocks
    css = css.replace(/^(\.[a-zA-Z][\w-]*)\s*\{([\s\S]*?)^\}/gm, (_match, selector, body) => {
        if (body.includes('{')) {
            return flattenNestedBlock(selector, body);
        }
        return `${selector} {${body}}`;
    });

    // Resolve CSS variables to concrete values
    css = css
        .replace(/var\(--font-sans\)/g, '"Inter", system-ui, -apple-system, sans-serif')
        .replace(/var\(--font-mono\)/g, '"JetBrains Mono", "Courier New", monospace')
        .replace(/var\(--color-muted-foreground\)/g, '#6b7280')
        .replace(/var\(--color-primary\)/g, '#2563eb')
        .replace(/var\(--color-link,\s*#2563eb\)/g, '#2563eb')
        .replace(/var\(--color-selected\)/g, '#bfdbfe');

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
                const nestedBody = current.trim();
                if (nestedSelector.startsWith('&')) {
                    const expanded = nestedSelector.replace(/&/g, parentSelector);
                    results.push(`${expanded} { ${nestedBody} }`);
                } else {
                    results.push(`${parentSelector} ${nestedSelector} { ${nestedBody} }`);
                }
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

const PRINT_EXTRAS = `
@page {
    size: A4;
    margin: 2.5cm;
}

/* Minimal Tailwind preflight — reset browser defaults that conflict with eigen-prose */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
ul, ol { list-style: none; }
img, svg { display: block; max-width: 100%; }
input, button, textarea, select { font: inherit; color: inherit; background-color: transparent; border-radius: 0; }
a { color: inherit; text-decoration: inherit; }
table { border-collapse: collapse; border-spacing: 0; }

body {
    font-family: "Inter", system-ui, -apple-system, sans-serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #1a1a2e;
    margin: 0;
    padding: 0;
}

/* Match the editor/quick-preview layout: A4 width with 2cm padding (screen only) */
.page {
    width: 210mm;
    max-width: 100%;
    margin: 0 auto;
    padding: 2cm;
    overflow-wrap: anywhere;
}

/* For PDF: @page margin handles whitespace, so remove .page padding */
@media print {
    .page { padding: 0; width: auto; }
}

/* Page break avoidance */
figure, table, pre, blockquote { page-break-inside: avoid; }

/* Clear floats before structural elements */
h1, h2, h3, h4, h5, h6, hr, blockquote, pre, table { clear: both; }

/* Text alignment (tiptap output classes) */
.has-text-align-center { text-align: center; }
.has-text-align-right { text-align: right; }
.has-text-align-left { text-align: left; }

/* Ensure pre wraps for PDF */
pre code { white-space: pre-wrap; font-family: "JetBrains Mono", "Courier New", monospace; }

/* Task list checkboxes — explicit sizing to match editor (16px) */
ul[data-type="taskList"] li > label input[type="checkbox"] {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: #2563eb;
}
`;

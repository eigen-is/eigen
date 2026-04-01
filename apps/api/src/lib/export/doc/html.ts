import * as fs from 'node:fs';
import { renderToHTMLString } from '@tiptap/static-renderer/pm/html-string';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import { common, createLowlight } from 'lowlight';
// Font paths resolved at build time — copied to outdir by the bundler
import fontExcalifont from '../../../../../../packages/ui/src/assets/fonts/excalifont/Excalifont-Regular.woff2' with {
    type: 'file',
};
import fontInterRegular from '../../../../../../packages/ui/src/assets/fonts/inter/Inter-Variable.woff2' with {
    type: 'file',
};
import fontInterItalic from '../../../../../../packages/ui/src/assets/fonts/inter/Inter-Variable-Italic.woff2' with {
    type: 'file',
};
import fontMonoRegular from '../../../../../../packages/ui/src/assets/fonts/jetbrains-mono/JetBrainsMono-Variable.woff2' with {
    type: 'file',
};
import fontSerifRegular from '../../../../../../packages/ui/src/assets/fonts/source-serif/SourceSerif4-Variable.woff2' with {
    type: 'file',
};
import fontSerifItalic from '../../../../../../packages/ui/src/assets/fonts/source-serif/SourceSerif4-Variable-Italic.woff2' with {
    type: 'file',
};
// CSS embedded as string at build time by Bun's bundler — no runtime file resolution needed
import eigenProseCSSRaw from '../../../../../../packages/ui/src/styles/eigen-prose.css' with { type: 'text' };
import type { Mount } from '../../mount';
import { loadEigendocContent } from './content';
import {
    type ExportResult,
    escapeHtml,
    renderCodeBlockNode,
    renderFigureNode,
    renderTaskItemNode,
    stripEigendocExtension,
} from './render';

const lowlight = createLowlight(common);
const extensions = getDocExtensions({ lowlight });

export type { ExportResult };

// Lazy-initialized cached assets
let _proseCSS: string | undefined;
let _fontCSS: string | undefined;

function getProseCSS() {
    return (_proseCSS ??= flattenEigenProseCSS(eigenProseCSSRaw as string));
}
function getFontCSS() {
    return (_fontCSS ??= buildFontFaceCSS());
}

export async function exportEigendocToHtml(mount: Mount, drivePath: DrivePath): Promise<ExportResult> {
    const html = await generateExportHtml(mount, drivePath);
    return {
        data: Buffer.from(html, 'utf-8'),
        contentType: 'text/html; charset=utf-8',
        fileName: `${stripEigendocExtension(drivePath.name)}.html`,
    };
}

export async function generateExportHtml(mount: Mount, drivePath: DrivePath): Promise<string> {
    const content = await loadEigendocContent(mount, drivePath);
    if (!content) return wrapInDocument(drivePath.name, '');

    const { pmJson, mediaByName } = content;

    const entries = await Promise.all(
        [...mediaByName].map(
            async ([name, file]) => [name, await readFileAsDataUri(mount, file.pathId, file.mimeType)] as const,
        ),
    );
    const dataUriMap = new Map(entries.filter((e): e is [string, string] => e[1] !== null));

    const bodyHtml = renderToHTMLString({
        content: pmJson,
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

    const sanitized = DOMPurify.sanitize(bodyHtml, { FORCE_BODY: true, ADD_DATA_URI_TAGS: ['img'] });
    return wrapInDocument(drivePath.name, sanitized);
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

async function readFileAsDataUri(mount: Mount, pathId: string, mimeType: string): Promise<string | null> {
    try {
        const file = await mount.readFile(pathId);
        if (!file) return null;
        const buffer = Buffer.from(await file.arrayBuffer());
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch {
        return null;
    }
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

// ── Font embedding ──────────────────────────────────────────────────────────

const FONT_FILES = [
    { family: 'Inter', path: fontInterRegular, weight: '100 900', style: 'normal' },
    { family: 'Inter', path: fontInterItalic, weight: '100 900', style: 'italic' },
    { family: 'Source Serif 4', path: fontSerifRegular, weight: '200 900', style: 'normal' },
    { family: 'Source Serif 4', path: fontSerifItalic, weight: '200 900', style: 'italic' },
    { family: 'JetBrains Mono', path: fontMonoRegular, weight: '100 800', style: 'normal' },
    { family: 'Excalifont', path: fontExcalifont, weight: '400', style: 'normal' },
] as const;

function buildFontFaceCSS(): string {
    return FONT_FILES.map((font) => {
        try {
            const buf = fs.readFileSync(font.path);
            const dataUri = `data:font/woff2;base64,${buf.toString('base64')}`;
            return `@font-face {
    font-family: "${font.family}";
    src: url("${dataUri}") format("woff2");
    font-weight: ${font.weight};
    font-style: ${font.style};
    font-display: swap;
}`;
        } catch {
            console.warn(`[export/html] Failed to read font: ${font.path}`);
            return '';
        }
    })
        .filter(Boolean)
        .join('\n');
}

const PRINT_EXTRAS = `
@page {
    size: A4;
    margin: 2.5cm;
}

* { box-sizing: border-box; }

body {
    font-family: "Inter", system-ui, -apple-system, sans-serif;
    font-size: 1rem;
    line-height: 1.7;
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
}

/* For PDF: @page margin handles whitespace, so remove .page padding */
@media print {
    .page { padding: 0; width: auto; }
}

/* Page break avoidance */
figure, table, pre, blockquote { page-break-inside: avoid; }

/* Text alignment (tiptap output classes) */
.has-text-align-center { text-align: center; }
.has-text-align-right { text-align: right; }
.has-text-align-left { text-align: left; }

/* Ensure pre wraps for PDF */
pre code { white-space: pre-wrap; font-family: "JetBrains Mono", "Courier New", monospace; }
`;

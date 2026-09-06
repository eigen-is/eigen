import { getExtension, type TextPreviewMode } from '@workspace/lib/constants/preview';
import { escapeHtml } from '@workspace/lib/html';
import { hastToHtml } from '../export/doc/render';
import { sanitizeExportHtml } from '../export/sanitize';

const LANGUAGE_MAP: Record<string, string> = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.rb': 'ruby',
    '.php': 'php',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.scala': 'scala',
    '.sql': 'sql',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.fish': 'bash',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.xml': 'xml',
    '.html': 'html',
    '.htm': 'html',
    '.css': 'css',
    '.csv': 'plaintext',
    '.graphql': 'graphql',
    '.gql': 'graphql',
    '.svelte': 'html',
    '.vue': 'html',
    '.astro': 'html',
    '.r': 'r',
    '.lua': 'lua',
    '.zig': 'zig',
    '.dart': 'dart',
    '.diff': 'diff',
    '.patch': 'diff',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.dockerfile': 'dockerfile',
    '.toml': 'ini',
    '.ini': 'ini',
    '.conf': 'ini',
    '.cfg': 'ini',
};

function getLanguageFromFileName(fileName: string): string | undefined {
    return LANGUAGE_MAP[getExtension(fileName)];
}

export type TextPreviewResult = {
    body: string;
    mode: TextPreviewMode;
};

export async function generateTextPreview(
    content: string,
    mode: TextPreviewMode,
    fileName: string,
): Promise<TextPreviewResult> {
    if (mode === 'markdown') {
        const MarkdownIt = (await import('markdown-it')).default;
        const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
        // Same ref-stripping sanitizer as every preview body: a `![](http://…)` image must not beacon viewers
        const body = sanitizeExportHtml(md.render(content));
        return { body, mode };
    }

    if (mode === 'code') {
        try {
            const { common, createLowlight } = await import('lowlight');
            const lowlight = createLowlight(common);

            const lang = getLanguageFromFileName(fileName);
            let highlighted: string;
            if (lang && lowlight.registered(lang)) {
                const tree = lowlight.highlight(lang, content);
                highlighted = hastToHtml(tree);
            } else {
                const tree = lowlight.highlightAuto(content);
                highlighted = hastToHtml(tree);
            }
            return { body: `<pre><code>${highlighted}</code></pre>`, mode };
        } catch {
            return { body: `<pre><code>${escapeHtml(content)}</code></pre>`, mode };
        }
    }

    // plaintext — prose paragraphs, NOT <pre>: eigen-prose paints every <pre> as a dark
    // non-wrapping code block, and .txt should read exactly like rendered markdown.
    const paragraphs = content
        .replace(/\r\n/g, '\n')
        .split(/\n{2,}/)
        .filter((block) => block.trim() !== '')
        .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`);
    return { body: paragraphs.join('\n') || '<p></p>', mode };
}

import {getTextPreviewMode, type TextPreviewMode} from '@workspace/lib/constants';
import DOMPurify from 'isomorphic-dompurify';

const LANGUAGE_MAP: Record<string, string> = {
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
    '.py': 'python', '.rs': 'rust', '.go': 'go', '.rb': 'ruby', '.php': 'php',
    '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
    '.swift': 'swift', '.kt': 'kotlin', '.scala': 'scala', '.sql': 'sql',
    '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.fish': 'bash',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.xml': 'xml',
    '.html': 'html', '.htm': 'html', '.css': 'css', '.csv': 'plaintext',
    '.graphql': 'graphql', '.gql': 'graphql',
    '.svelte': 'html', '.vue': 'html', '.astro': 'html',
    '.r': 'r', '.lua': 'lua', '.zig': 'zig', '.dart': 'dart',
    '.diff': 'diff', '.patch': 'diff',
    '.md': 'markdown', '.markdown': 'markdown',
    '.dockerfile': 'dockerfile',
    '.toml': 'ini', '.ini': 'ini', '.conf': 'ini', '.cfg': 'ini',
};

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getLanguageFromFileName(fileName: string): string | undefined {
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    return LANGUAGE_MAP[ext];
}

export function isTextPreviewSupported(mimeType: string, fileName: string): boolean {
    return getTextPreviewMode(mimeType, fileName) !== null;
}

export type TextPreviewResult = {
    body: string;
    mode: TextPreviewMode;
};

export async function generateTextPreview(content: string, mimeType: string, fileName: string): Promise<TextPreviewResult> {
    const mode = getTextPreviewMode(mimeType, fileName)!;

    if (mode === 'markdown') {
        const MarkdownIt = (await import('markdown-it')).default;
        const md = new MarkdownIt({html: false, linkify: true, typographer: true});
        const body = DOMPurify.sanitize(md.render(content), {FORCE_BODY: true});
        return {body, mode};
    }

    if (mode === 'code') {
        try {
            const {createLowlight} = await import('lowlight');
            const {common} = await import('lowlight');
            const lowlight = createLowlight(common);

            const lang = getLanguageFromFileName(fileName);
            let highlighted: string;
            if (lang && lowlight.registered(lang)) {
                const tree = lowlight.highlight(lang, content);
                highlighted = toHtml(tree);
            } else {
                const tree = lowlight.highlightAuto(content);
                highlighted = toHtml(tree);
            }
            return {body: `<pre><code>${highlighted}</code></pre>`, mode};
        } catch {
            return {body: `<pre><code>${escapeHtml(content)}</code></pre>`, mode};
        }
    }

    // plaintext
    return {body: `<pre><code>${escapeHtml(content)}</code></pre>`, mode};
}

function toHtml(tree: {
    type: string;
    children?: any[];
    value?: string;
    tagName?: string;
    properties?: Record<string, any>
}): string {
    if (tree.type === 'text') return escapeHtml(tree.value || '');
    if (tree.type === 'element' && tree.tagName) {
        const props = tree.properties || {};
        const className = props['className'] ? ` class="${(props['className'] as string[]).join(' ')}"` : '';
        const children = (tree.children || []).map(toHtml).join('');
        return `<${tree.tagName}${className}>${children}</${tree.tagName}>`;
    }
    if (tree.type === 'root' && tree.children) {
        return tree.children.map(toHtml).join('');
    }
    return '';
}

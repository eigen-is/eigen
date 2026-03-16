import {wrapHtml} from './html-template';

type TextPreviewMode = 'markdown' | 'plaintext' | 'code';

function getPreviewMode(mimeType: string, fileName: string): TextPreviewMode | null {
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    if (mimeType === 'text/markdown' || ext === '.md' || ext === '.markdown') return 'markdown';
    if (mimeType === 'text/plain' || ext === '.txt') return 'plaintext';
    if (mimeType.startsWith('text/') || mimeType.startsWith('application/json') ||
        mimeType.startsWith('application/javascript') || mimeType.startsWith('application/typescript') ||
        mimeType.startsWith('application/xml') || mimeType.startsWith('application/x-yaml') ||
        mimeType.startsWith('application/x-sh') || mimeType.startsWith('application/toml')) return 'code';
    const codeExts = new Set([
        '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.csv',
        '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
        '.py', '.rs', '.go', '.rb', '.php', '.java', '.c', '.cpp', '.h', '.hpp',
        '.swift', '.kt', '.scala', '.sql', '.graphql', '.gql',
        '.sh', '.bash', '.zsh', '.fish', '.conf', '.cfg', '.ini', '.toml',
        '.env', '.gitignore', '.dockerignore', '.editorconfig',
        '.log', '.diff', '.patch', '.svelte', '.vue', '.astro', '.dockerfile',
        '.r', '.lua', '.zig', '.dart',
    ]);
    if (codeExts.has(ext)) return 'code';
    return null;
}

export function isTextPreviewSupported(mimeType: string, fileName: string): boolean {
    return getPreviewMode(mimeType, fileName) !== null;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getLanguageFromFileName(fileName: string): string | undefined {
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    const langMap: Record<string, string> = {
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
    return langMap[ext];
}

export async function generateTextPreview(content: string, mimeType: string, fileName: string): Promise<string> {
    const mode = getPreviewMode(mimeType, fileName);

    if (mode === 'markdown') {
        const MarkdownIt = (await import('markdown-it')).default;
        const md = new MarkdownIt({html: false, linkify: true, typographer: true});
        const body = md.render(content);
        return wrapHtml(body, fileName);
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
            const body = `<pre><code>${highlighted}</code></pre>`;
            return wrapHtml(body, fileName);
        } catch {
            // Fallback to plain pre block if lowlight fails
            const body = `<pre><code>${escapeHtml(content)}</code></pre>`;
            return wrapHtml(body, fileName);
        }
    }

    // plaintext
    const body = `<pre><code>${escapeHtml(content)}</code></pre>`;
    return wrapHtml(body, fileName);
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

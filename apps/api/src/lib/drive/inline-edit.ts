export const MAX_INLINE_EDIT_SIZE = 5 * 1024 * 1024; // 5 MB

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export function extractFrontmatter(content: string): { frontmatter: string | null; body: string } {
    const match = content.match(FRONTMATTER_RE);
    if (match) return {frontmatter: match[1], body: match[2]};
    return {frontmatter: null, body: content};
}

export function reattachFrontmatter(body: string, frontmatter: string | null): string {
    if (!frontmatter) return body;
    return `---\n${frontmatter}\n---\n${body}`;
}

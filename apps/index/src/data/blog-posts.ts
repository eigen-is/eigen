export type BlogPost = {
    id: string;
    title: string;
    date: string;
    summary: string;
    content: string;
}

const blogFiles = import.meta.glob('./blog/*.md', {eager: true, query: '?raw', import: 'default'});

function parseFrontmatter(markdown: string): { data: Record<string, string>; content: string } {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
    const match = markdown.match(frontmatterRegex);

    if (!match) {
        return {data: {}, content: markdown};
    }

    const frontmatterText = match[1];
    const content = match[2];
    const data: Record<string, string> = {};

    for(const line of frontmatterText.split('\n')) {
        const colonIndex = line.indexOf(':');
        if (colonIndex !== -1) {
            const key = line.substring(0, colonIndex).trim();
            const value = line.substring(colonIndex + 1).trim().replace(/^["']|["']$/g, '');
            data[key] = value;
        }
    }

    return {data, content};
}

function parseBlogPosts(): BlogPost[] {
    const posts: BlogPost[] = [];

    for (const [path, content] of Object.entries(blogFiles)) {
        const filename = path.split('/').pop() || '';
        const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})-/);
        const date = dateMatch ? dateMatch[1] : '';

        const {data, content: markdownContent} = parseFrontmatter(content as string);

        posts.push({
            id: data.id || '',
            title: data.title || '',
            date: date,
            summary: data.summary || '',
            content: markdownContent,
        });
    }

    return posts.sort((a, b) => b.date.localeCompare(a.date));
}

export const blogPosts: BlogPost[] = parseBlogPosts();

export function getBlogPost(id: string): BlogPost | undefined {
    return blogPosts.find(post => post.id === id);
}

export function getLatestBlogPost(): BlogPost | undefined {
    return blogPosts[0];
}

export function getAllBlogPosts(): BlogPost[] {
    return blogPosts;
}

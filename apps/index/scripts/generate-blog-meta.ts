import {readdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

interface BlogPostMeta {
    title: string;
    summary: string;
    date: string;
}

interface BlogMetaData {
    [key: string]: BlogPostMeta;
}

function parseFrontmatter(markdown: string): { data: Record<string, string>; content: string } {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
    const match = markdown.match(frontmatterRegex);

    if (!match) {
        return { data: {}, content: markdown };
    }

    const frontmatterText = match[1];
    const content = match[2];
    const data: Record<string, string> = {};

    frontmatterText.split('\n').forEach(line => {
        const colonIndex = line.indexOf(':');
        if (colonIndex !== -1) {
            const key = line.substring(0, colonIndex).trim();
            const value = line.substring(colonIndex + 1).trim().replace(/^["']|["']$/g, '');
            data[key] = value;
        }
    });

    return { data, content };
}

function generateBlogMeta() {
    const blogDir = join(process.cwd(), 'src', 'data', 'blog');
    const outputPath = join(process.cwd(), 'public', 'blog-meta.json');
    
    const files = readdirSync(blogDir).filter(file => file.endsWith('.md'));
    const blogMeta: BlogMetaData = {};

    for (const file of files) {
        const content = readFileSync(join(blogDir, file), 'utf-8');
        const { data } = parseFrontmatter(content);
        
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})-/);
        const date = dateMatch ? dateMatch[1] : '';

        if (data.id) {
            blogMeta[data.id] = {
                title: data.title || '',
                summary: data.summary || '',
                date: date,
            };
        }
    }

    writeFileSync(outputPath, JSON.stringify(blogMeta, null, 2));
    console.log(`Generated blog-meta.json with ${Object.keys(blogMeta).length} posts`);
}

generateBlogMeta();

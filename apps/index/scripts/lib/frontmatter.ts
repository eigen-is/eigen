import matter from 'gray-matter';
import type { z } from 'zod';

export function parseContentFile<T extends z.ZodTypeAny>(raw: string, schema: T): { data: z.infer<T>; body: string } {
    const parsed = matter(raw);
    const result = schema.safeParse(parsed.data);
    if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        throw new Error(`Invalid frontmatter: ${issues}`);
    }
    return { data: result.data, body: parsed.content };
}

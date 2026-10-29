// Splits a content file, such as a support article or a blog post, into its YAML frontmatter
// and its Markdown body, and checks the frontmatter against a zod schema. The content build
// calls it for every file, so a bad field fails the build with a readable message.

import type { z } from 'zod';

export function parseContentFile<T extends z.ZodTypeAny>(raw: string, schema: T): { data: z.infer<T>; body: string } {
    const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    const result = schema.safeParse(frontmatter ? Bun.YAML.parse(frontmatter[1]) : {});
    if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        throw new Error(`Invalid frontmatter: ${issues}`);
    }
    return { data: result.data, body: frontmatter ? raw.slice(frontmatter[0].length) : raw };
}

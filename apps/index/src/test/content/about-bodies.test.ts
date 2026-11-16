import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { aboutApps } from '../../content/about-apps';
import type { ArticleBody } from '../../content/manifest';

const GENERATED = join(import.meta.dir, '../../content/.generated/about');

describe('About page bodies', () => {
    test('link a help article on the words of a sentence, never as a title in parentheses', async () => {
        for (const slug of ['index', ...aboutApps.map((app) => app.slug)]) {
            const { html }: ArticleBody = await Bun.file(join(GENERATED, `${slug}.json`)).json();
            expect({ slug, links: html.match(/\(<a href="\/support\/[^"]*">[^<]*<\/a>/g) ?? [] }).toEqual({
                slug,
                links: [],
            });
        }
    });
});

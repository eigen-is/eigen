// The changelog page: every release of Eigen, newest first, with a list of the versions in the left gutter. The
// build turns CHANGELOG.md into the HTML and the version list, and the prerender has both, so a visitor without
// scripts reads the whole page.

import { createFileRoute } from '@tanstack/react-router';
import { AppShell } from '@workspace/ui/components/layout/app';
import { ArticleContent } from '../components/article-content';
import { ArticleToc } from '../components/article-toc';
import { ReadingLayout } from '../components/reading-layout';
import { SitePage } from '../components/site-page';
import type { ChangelogBody } from '../content/manifest';

// Eager glob (not a static import) so a not-yet-generated file degrades to an empty body
// in dev instead of breaking the module load. Regenerated on every prod build by
// scripts/build-changelog.ts (prebuild).
const generated = import.meta.glob<ChangelogBody>('../content/.generated/changelog.json', {
    eager: true,
    import: 'default',
});
const body: ChangelogBody = Object.values(generated)[0] ?? { html: '', mediaGrids: [], versions: [] };
const versions = body.versions.map(({ id, version, date }) => ({ id, text: version, detail: date }));

export const Route = createFileRoute('/changelog')({
    component: ChangelogPage,
    head: () => ({
        meta: [
            { title: 'Changelog - eigen' },
            { name: 'description', content: 'Release notes and user-visible changes to eigen, newest first.' },
            { property: 'og:title', content: 'Changelog - eigen' },
            {
                property: 'og:description',
                content: 'Release notes and user-visible changes to eigen, newest first.',
            },
            { property: 'og:type', content: 'website' },
        ],
    }),
});

function ChangelogPage() {
    return (
        <AppShell appName="changelog" rootRoute={Route}>
            <SitePage>
                <ReadingLayout aside={<ArticleToc toc={versions} label="Versions" />}>
                    <h1 className="site-title">Changelog</h1>
                    <p className="mt-2 text-muted-foreground">What changed in Eigen, newest first.</p>
                    <ArticleContent body={body} className="changelog mt-10" />
                </ReadingLayout>
            </SitePage>
        </AppShell>
    );
}

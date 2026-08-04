import { createFileRoute } from '@tanstack/react-router';
import { AppShell } from '@workspace/ui/components/layout/app/app-shell';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import { ArticleContent } from '../components/article-content';
import type { ArticleBody } from '../content/manifest';

// Eager glob (not a static import) so a not-yet-generated file degrades to an empty body
// in dev instead of breaking the module load. Regenerated on every prod build by
// scripts/build-changelog.ts (prebuild).
const generated = import.meta.glob<ArticleBody>('../content/.generated/changelog.json', {
    eager: true,
    import: 'default',
});
const body: ArticleBody = Object.values(generated)[0] ?? { html: '', mediaGrids: [] };

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
            <ColumnLayout>
                <Column id="changelog" width="flex">
                    <div className="h-full overflow-y-auto">
                        <div className="mx-auto w-full max-w-[70ch] px-6 py-10">
                            <h1 className="text-4xl font-medium mb-2">Changelog</h1>
                            <p className="text-sm text-muted-foreground mb-6">
                                User-visible changes to eigen, newest first.
                            </p>
                            <ArticleContent body={body} className="eigen-prose" />
                        </div>
                    </div>
                </Column>
            </ColumnLayout>
        </AppShell>
    );
}

// The About overview's route. It finds the overview and its body, and hands them to the page that draws them. The
// prerender has the body inlined, so the first client render matches the server's.

import { createFileRoute } from '@tanstack/react-router';
import { LoadingState } from '@workspace/ui/components/layout/app';
import { AboutOverview } from '../components/about-overview';
import { SitePage } from '../components/site-page';
import { getAboutOverview } from '../content/manifest';
import { useArticleBody } from '../content/use-article-body';

export const Route = createFileRoute('/about/')({
    component: AboutOverviewComponent,
    head: () => {
        const overview = getAboutOverview();
        return {
            meta: [
                { title: overview.title },
                { name: 'description', content: overview.description },
                { property: 'og:title', content: overview.title },
                { property: 'og:description', content: overview.description },
                { property: 'og:type', content: 'website' },
            ],
        };
    },
});

function AboutOverviewComponent() {
    const overview = getAboutOverview();
    const body = useArticleBody('about', 'index');

    if (!body) {
        return (
            <SitePage>
                <LoadingState />
            </SitePage>
        );
    }
    return <AboutOverview overview={overview} body={body} />;
}

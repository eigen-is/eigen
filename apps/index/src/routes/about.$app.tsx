// An app's About page. It finds the app, its page and its body, and hands them with the previous and the next app's
// page to the page that draws them. The prerender has the body inlined, so the first client render matches the
// server's. Each app mounts its own page, so the next one opens at the top.

import { createFileRoute, useParams } from '@tanstack/react-router';
import { ErrorState, LoadingState, useLayout } from '@workspace/ui/components/layout/app';
import { useEffect } from 'react';
import { AboutPage } from '../components/about-page';
import { SitePage } from '../components/site-page';
import { aboutApps } from '../content/about-apps';
import { getAboutArticle, getAboutArticles } from '../content/manifest';
import { useArticleBody } from '../content/use-article-body';

export const Route = createFileRoute('/about/$app')({
    component: AboutPageComponent,
    head: ({ params }) => {
        const page = getAboutArticle(params.app);
        if (!page) return { meta: [{ title: 'Page not found - eigen' }] };
        return {
            meta: [
                { title: `${page.title} - eigen` },
                { name: 'description', content: page.description },
                { property: 'og:title', content: page.title },
                { property: 'og:description', content: page.description },
                { property: 'og:type', content: 'article' },
            ],
        };
    },
});

function AboutPageComponent() {
    const { app: slug } = useParams({ from: '/about/$app' });
    const app = aboutApps.find((entry) => entry.slug === slug);
    const page = getAboutArticle(slug);
    const body = useArticleBody('about', slug);
    const { setDocumentTitle } = useLayout();

    useEffect(() => {
        setDocumentTitle(page?.title ?? '');
        return () => setDocumentTitle('');
    }, [page?.title, setDocumentTitle]);

    if (!app || !page || !body) {
        return <SitePage>{app && page ? <LoadingState /> : <ErrorState />}</SitePage>;
    }

    const pages = getAboutArticles();
    const index = pages.indexOf(page);
    return (
        <AboutPage key={slug} app={app} page={page} body={body} previous={pages[index - 1]} next={pages[index + 1]} />
    );
}

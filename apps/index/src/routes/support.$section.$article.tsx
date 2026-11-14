// A Support article's page. It finds the article, its body and its related articles, and hands them to the page that
// draws them. The prerender has the body inlined, so the first client render matches the server's. Each article
// mounts its own page, so a related one opens at the top.

import { createFileRoute, useParams } from '@tanstack/react-router';
import { ErrorState, LoadingState, useLayout } from '@workspace/ui/components/layout/app';
import { useEffect } from 'react';
import { SitePage } from '../components/site-page';
import { SupportArticle } from '../components/support/support-article';
import type { ArticleMeta } from '../content/manifest';
import { getSupportArticle, getSupportArticles } from '../content/manifest';
import { useArticleBody } from '../content/use-article-body';

export const Route = createFileRoute('/support/$section/$article')({
    component: ArticleComponent,
    head: ({ params }) => {
        const article = getSupportArticle(params.section, params.article);
        if (!article) return { meta: [{ title: 'Article not found - Eigen Support' }] };
        return {
            meta: [
                { title: `${article.title} - Eigen Support` },
                { name: 'description', content: article.description },
                { property: 'og:title', content: article.title },
                { property: 'og:description', content: article.description },
                { property: 'og:type', content: 'article' },
            ],
        };
    },
});

function ArticleComponent() {
    const { section, article: file } = useParams({ from: '/support/$section/$article' });
    const article = getSupportArticle(section, file);
    const body = useArticleBody('support', `${section}/${file}`);
    const { setDocumentTitle } = useLayout();

    useEffect(() => {
        setDocumentTitle(article?.title ?? '');
        return () => setDocumentTitle('');
    }, [article?.title, setDocumentTitle]);

    if (!article || !body) {
        return <SitePage>{article ? <LoadingState /> : <ErrorState />}</SitePage>;
    }

    const all = getSupportArticles();
    const bySlug = new Map(all.map((a) => [a.slug, a]));
    const related = article.related.map((slug) => bySlug.get(slug)).filter((a): a is ArticleMeta => a !== undefined);

    return <SupportArticle key={article.slug} article={article} body={body} related={related} />;
}

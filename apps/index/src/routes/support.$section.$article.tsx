import { createFileRoute, useParams } from '@tanstack/react-router';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context';
import { useEffect } from 'react';
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

    if (!article) {
        return <div className="p-8 text-muted-foreground">Article not found.</div>;
    }
    if (!body) {
        return <div className="p-8 text-muted-foreground">Loading…</div>;
    }

    const all = getSupportArticles();
    const bySlug = new Map(all.map((a) => [a.slug, a]));
    const related = article.related.map((slug) => bySlug.get(slug)).filter((a): a is ArticleMeta => a !== undefined);

    return <SupportArticle article={article} body={body} related={related} />;
}

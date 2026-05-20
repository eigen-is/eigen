import { createFileRoute, useParams } from '@tanstack/react-router';
import { SupportArticle } from '../components/support/support-article';
import type { ArticleMeta } from '../content/manifest';
import { getArticleBody, getSupportArticle, getSupportArticles } from '../content/manifest';

export const Route = createFileRoute('/support/$section/$article')({
    component: ArticleComponent,
    head: ({ params }) => {
        const article = getSupportArticle(params.section, params.article);
        if (!article) return { meta: [{ title: 'Article not found - Eigen Help' }] };
        const url = `https://eigen.is/support/${params.section}/${params.article}`;
        return {
            meta: [
                { title: `${article.title} - Eigen Help` },
                { name: 'description', content: article.description },
                { property: 'og:title', content: article.title },
                { property: 'og:description', content: article.description },
                { property: 'og:type', content: 'article' },
                { property: 'og:url', content: url },
            ],
        };
    },
});

function ArticleComponent() {
    const { section, article: file } = useParams({ from: '/support/$section/$article' });
    const article = getSupportArticle(section, file);
    const body = article ? getArticleBody('support', article.slug) : undefined;

    if (!article || !body) {
        return <div className="p-8 text-muted-foreground">Article not found.</div>;
    }

    const siblings = getSupportArticles().filter((a) => a.section === article.section);
    const bySlug = new Map(getSupportArticles().map((a) => [a.slug, a]));
    const related = article.related.map((slug) => bySlug.get(slug)).filter((a): a is ArticleMeta => a !== undefined);

    return <SupportArticle article={article} body={body} siblings={siblings} related={related} />;
}

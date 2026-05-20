import { type ArticleMeta, getBlogArticle, getBlogArticles } from '../content/manifest';

export type BlogPost = ArticleMeta;

export function getAllBlogPosts(): BlogPost[] {
    return getBlogArticles();
}

export function getBlogPost(id: string): BlogPost | undefined {
    return getBlogArticle(id);
}

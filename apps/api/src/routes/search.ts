import type { SearchResponse } from '@workspace/lib/types/search';
import { Elysia, t } from 'elysia';
import { requireSelf } from '../lib/core/access';
import { getHome } from '../lib/home';
import { betterAuth } from './auth';

export const searchRouter = new Elysia({ name: 'search' })
    .use(betterAuth)

    .get(
        '/search/:ownerId',
        async ({ params, query, user }): Promise<SearchResponse> => {
            requireSelf(params.ownerId, user.id);
            const home = await getHome(params.ownerId);

            const sources = query.sources
                ?.split(',')
                .map((source) => source.trim())
                .filter((source) => source.length > 0);
            const searchMail = !sources || sources.includes('mail');

            const mail = searchMail ? home.mail.search(query.q, query.limit ?? 20) : [];
            return { mail };
        },
        {
            auth: true,
            query: t.Object({
                q: t.String({ minLength: 1 }),
                sources: t.Optional(t.String()),
                limit: t.Optional(t.Number({ minimum: 1, maximum: 50 })),
            }),
        },
    );

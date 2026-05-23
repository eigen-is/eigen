import type { SearchResponse } from '@workspace/lib/types/search';
import { Elysia, t } from 'elysia';
import { requireNonGuest, requireSelf } from '../lib/core/access';
import { getHome } from '../lib/home';
import { betterAuth } from './auth';

export const searchRouter = new Elysia({ name: 'search' })
    .use(betterAuth)

    .get(
        '/search/:ownerId',
        async ({ params, query, user }): Promise<SearchResponse> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const home = await getHome(params.ownerId);

            const sources = query.sources
                ?.split(',')
                .map((source) => source.trim())
                .filter((source) => source.length > 0);
            const searchMail = !sources || sources.includes('mail');

            const mailboxes = query.mailbox
                ?.split(',')
                .map((m) => m.trim())
                .filter((m) => m.length > 0)
                .map((m) => (m.toLowerCase() === 'inbox' ? '' : m));
            const mail = searchMail
                ? home.mail.search({
                      q: query.q,
                      limit: query.limit ?? 20,
                      mailboxes,
                      from: query.from,
                      to: query.to,
                  })
                : [];
            return { mail };
        },
        {
            auth: true,
            query: t.Object({
                q: t.String({ minLength: 1, maxLength: 256 }),
                sources: t.Optional(t.String()),
                mailbox: t.Optional(t.String()),
                from: t.Optional(t.String({ maxLength: 256 })),
                to: t.Optional(t.String({ maxLength: 256 })),
                limit: t.Optional(t.Number({ minimum: 1, maximum: 50 })),
            }),
        },
    );

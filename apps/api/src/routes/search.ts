import type { DrivePath } from '@workspace/lib/types/drive';
import type { SearchResponse, SearchSource } from '@workspace/lib/types/search';
import { Elysia, t } from 'elysia';
import { requireNonGuest, requireSelf } from '../lib/core/access';
import { aggregateFileSearch } from '../lib/drive/aggregate';
import { getHome } from '../lib/home';
import { betterAuth } from './auth';

const SOURCE_VALUES: SearchSource[] = ['mail', 'file'];

function isSource(value: string): value is SearchSource {
    return (SOURCE_VALUES as string[]).includes(value);
}

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
                .filter(isSource);
            const searchMail = !sources || sources.includes('mail');
            const searchFile = !sources || sources.includes('file');
            const limit = query.limit ?? 20;

            // Pass user-typed names through verbatim; Mail.search() owns the canonical
            // casing rules (Inbox -> '', case-insensitive match against STANDARD_MAILBOXES).
            const mailboxes = query.mailbox
                ?.split(',')
                .map((m) => m.trim())
                .filter((m) => m.length > 0);
            const mail = searchMail
                ? home.mail.search({
                      q: query.q,
                      limit,
                      mailboxes,
                      from: query.from,
                      to: query.to,
                  })
                : [];

            let file: DrivePath[] = [];
            if (searchFile) {
                // ?teams fans the file source out over the caller's team memberships (self-only route).
                file = query.teams
                    ? await aggregateFileSearch(user, query.q, limit)
                    : home.drive.search({ q: query.q, limit });
            }
            return { mail, file };
        },
        {
            auth: true,
            query: t.Object({
                q: t.String({ minLength: 1, maxLength: 256 }),
                sources: t.Optional(t.String()),
                mailbox: t.Optional(t.String()),
                from: t.Optional(t.String({ maxLength: 256 })),
                to: t.Optional(t.String({ maxLength: 256 })),
                limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
                teams: t.Optional(t.String()),
            }),
        },
    );

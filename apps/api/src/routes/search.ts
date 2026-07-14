import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { SearchResponse, SearchSource } from '@workspace/lib/types/search';
import { Elysia, t } from 'elysia';
import { requireNonGuest, requireSelf } from '../lib/core/access';
import { getHome } from '../lib/home';
import { pullDriveSearch } from '../lib/home/home-relay';
import { getMemberships } from '../lib/user';
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
                const personal = home.drive.search({ q: query.q, limit });
                if (query.teams) {
                    // Fan out over the caller's team memberships (self-only route; team membership grants
                    // read of the whole mount). Each team keeps the full limit so recency competes fairly.
                    const { teamIds } = await getMemberships(user.id);
                    const teamResults = await Promise.all(
                        teamIds.map((teamId) =>
                            pullDriveSearch(teamOwnerId(teamId), { q: query.q, limit }).catch(() => [] as DrivePath[]),
                        ),
                    );
                    const byId = new Map<string, DrivePath>();
                    for (const path of personal) byId.set(path.id, path);
                    for (const list of teamResults) for (const path of list) byId.set(path.id, path);
                    file = [...byId.values()]
                        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
                        .slice(0, limit);
                } else {
                    file = personal;
                }
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

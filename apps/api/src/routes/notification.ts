import {Elysia, t} from 'elysia';
import {betterAuth} from './auth';
import {getHome} from '../lib/home';
import {requireSelf} from '../lib/core/access';

export const notificationRouter = new Elysia({name: 'notification'})
    .use(betterAuth)

    .get('/notifications/:ownerId', async ({params, query, user}) => {
        requireSelf(params.ownerId, user.id);
        const home = await getHome(params.ownerId);
        const before = query.before ? new Date(query.before) : undefined;
        return home.notifications.list(query.limit ?? 50, before);
    }, {
        auth: true,
        query: t.Object({
            limit: t.Optional(t.Number({minimum: 1, maximum: 100})),
            before: t.Optional(t.String()),
        }),
    })

    .get('/notifications/:ownerId/unread-count', async ({params, user}) => {
        requireSelf(params.ownerId, user.id);
        const home = await getHome(params.ownerId);
        return {count: home.notifications.unreadCount()};
    }, {auth: true})

    .patch('/notifications/:ownerId/:id/read', async ({params, user}) => {
        requireSelf(params.ownerId, user.id);
        const home = await getHome(params.ownerId);
        home.notifications.markRead(params.id);
        return {success: true};
    }, {auth: true})

    .post('/notifications/:ownerId/mark-all-read', async ({params, user}) => {
        requireSelf(params.ownerId, user.id);
        const home = await getHome(params.ownerId);
        home.notifications.markAllRead();
        return {success: true};
    }, {auth: true})

    .delete('/notifications/:ownerId/:id', async ({params, user}) => {
        requireSelf(params.ownerId, user.id);
        const home = await getHome(params.ownerId);
        home.notifications.dismiss(params.id);
        return {success: true};
    }, {auth: true});

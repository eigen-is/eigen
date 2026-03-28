import {Elysia} from 'elysia';
import {requireSelf} from '../lib/core/access';
import {getHome} from '../lib/home';
import {getMemberships} from '../lib/user';
import {betterAuth} from './auth.ts';

// Home routes are personal-only (storage size, data export)
export const homeRouter = new Elysia({name: 'home'})
    .use(betterAuth)

    .get(
        '/home/:ownerId/size',
        async ({params, user}) => {
            requireSelf(params.ownerId, user.id);
            const home = await getHome(user.id);
            const {teamIds} = await getMemberships(user.id);
            return await home.size(teamIds);
        },
        {
            auth: true,
        },
    );

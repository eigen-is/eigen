import type {User} from 'better-auth/types';
import {createAsyncSingleton} from '../../utils/singleton';
import {getUserById} from '../users/users';
import {Home} from './home';

const homeFactories: Map<string, () => Promise<Home>> = new Map();

export function getHome(user: User): Promise<Home> {
    if (!homeFactories.has(user.id)) {
        homeFactories.set(user.id, createAsyncSingleton(async () => {
            const userExists = await getUserById(user.id);
            if (!userExists) {
                throw new Error('User not found');
            }

            const home = new Home(user);
            await home.init();
            return home.touch();
        }));
    }

    return homeFactories.get(user.id)!();
}

export function cleanupHomeFactory(userId: string): void {
    homeFactories.delete(userId);
}

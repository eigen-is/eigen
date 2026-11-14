// Whether the signed-in user is a guest, an account that only reaches what was shared with it. Hooks such as
// the backup job list skip a query a guest may not make, and views hide what a guest can't use.

import { useAuth } from '../auth-context';

export function useIsGuest(): boolean {
    const { user } = useAuth();
    return user?.role === 'guest';
}

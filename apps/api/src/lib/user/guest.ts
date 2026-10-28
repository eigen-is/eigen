// The guest rule: a guest is an account with the role 'guest', signed in by an emailed code. It lives apart
// from the user lookups, which load auth, so a light module can use it too, such as the backup's home list.

import type { User } from './user';

// The role a guest account is created with, which a query filters on where it can't call isGuest.
export const GUEST_ROLE = 'guest';

// A missing user is not a guest.
export function isGuest(user: Pick<User, 'role'> | null | undefined): boolean {
    return user?.role === GUEST_ROLE;
}

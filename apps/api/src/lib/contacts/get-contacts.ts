// Finds the Contacts of the user who makes a request. An address book is personal, so the owner in the URL has to
// be the caller. The contacts routes use it instead of each checking this on their own.

import { requireSelf } from '../auth/access';
import { getHome } from '../home';
import type { User } from '../user';
import type { Contacts } from './contacts';

// A book is personal: no team home holds one and none is ever shared, so the only owner it answers to is
// the caller themselves — the same rule every contacts route carried inline.
export async function resolveContacts(user: User, ownerId: string): Promise<Contacts> {
    requireSelf(ownerId, user.id);
    const home = await getHome(user.id); // own home; a book is never reached across homes
    return home.contacts;
}

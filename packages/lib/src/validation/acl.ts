import { parseOwnerId } from '../types';

export function validateACLEntries(acl: { id: string }[]): string | null {
    for (const entry of acl) {
        if (parseOwnerId(entry.id).id === '') {
            return `Invalid ACL entry: '${entry.id}'`;
        }
    }
    return null;
}

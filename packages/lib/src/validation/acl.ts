import { parseOwnerId } from '../types';

export function validateACLEntries(acl: { id: string }[]): string | null {
    for (const entry of acl) {
        try {
            parseOwnerId(entry.id);
        } catch {
            return `Invalid ACL entry: '${entry.id}'`;
        }
    }
    return null;
}

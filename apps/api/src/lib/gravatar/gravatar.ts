import {getUserByEmail} from "../users/users";

export async function getUserByEmailHash(hash: string, baseUrl: string) {
    const user = await getUserByEmail(hash);
    if (user) {
        return {
            hash,
            displayName: user.name,
            profileUrl: `${baseUrl}/profile/${user.id}`,
            avatarUrl: user.image ? `${baseUrl}${user.image}` : null,
        };
    }
    return null;
}

export async function getUsersByEmailHashes(hashes: string[], baseUrl: string) {
    const results: Record<string, any> = {};
    for (const hash of hashes) {
        results[hash] = await getUserByEmailHash(hash, baseUrl);
    }
    return results;
}

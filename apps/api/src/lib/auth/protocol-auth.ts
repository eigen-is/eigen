import { ApiError } from '../core/errors';
import { getUserByEmail } from '../user';
import { auth } from './auth';

export type ProtocolUser = {
    id: string;
    email: string;
    name: string;
};

export async function verifyProtocolAuth(email: string, password: string): Promise<ProtocolUser> {
    const user = await getUserByEmail(email);
    if (!user) throw new ApiError(401, 'Unauthorized');

    // 1. Try app password (API key)
    const keyResult = await auth.api.verifyApiKey({ body: { key: password } });
    if (keyResult.valid && keyResult.key?.referenceId === user.id) {
        return { id: user.id, email: user.email, name: user.name };
    }

    // 2. Fall back to primary password (only works when 2FA is not enabled)
    try {
        await auth.api.signInEmail({ body: { email, password } });
        return { id: user.id, email: user.email, name: user.name };
    } catch {
        throw new ApiError(401, 'Unauthorized');
    }
}

import { type ProtocolUser, verifyProtocolAuth } from '../auth/protocol-auth';
import { ApiError } from '../core/errors';

export type CalDavUser = ProtocolUser;

export async function authenticateBasic(request: Request): Promise<ProtocolUser> {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Basic ')) {
        throw new ApiError(401, 'Unauthorized');
    }

    let decoded: string;
    try {
        decoded = atob(authHeader.slice(6));
    } catch {
        throw new ApiError(401, 'Unauthorized');
    }
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) {
        throw new ApiError(401, 'Unauthorized');
    }

    const email = decoded.slice(0, colonIndex);
    const password = decoded.slice(colonIndex + 1);

    return verifyProtocolAuth(email, password);
}

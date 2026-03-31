import { ApiError } from '../core/errors';
import { getUserByEmail } from '../user';

export type CalDavUser = {
    id: string;
    email: string;
    name: string;
};

export async function authenticateBasic(request: Request): Promise<CalDavUser> {
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
    const user = await getUserByEmail(email);
    if (!user) {
        throw new ApiError(401, 'Unauthorized');
    }

    // SECURITY: password validation not yet implemented — accepts any password.
    // CalDAV is not safe for production until app-specific passwords are added.
    return { id: user.id, email: user.email, name: user.name };
}

import { getUserByEmail } from '../user';

export type CalDavUser = {
    id: string;
    email: string;
    name: string;
};

export async function authenticateBasic(request: Request): Promise<CalDavUser> {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Basic ')) {
        throw new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="Eigen CalDAV"' },
        });
    }

    const decoded = atob(authHeader.slice(6));
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) {
        throw new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="Eigen CalDAV"' },
        });
    }

    const email = decoded.slice(0, colonIndex);

    const user = await getUserByEmail(email);
    if (!user) {
        throw new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="Eigen CalDAV"' },
        });
    }

    // TODO: validate password (app-specific passwords). For now, accept any password.
    return { id: user.id, email: user.email, name: user.name };
}

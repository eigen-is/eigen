import { apiKeyClient } from '@better-auth/api-key/client';
import { createAuthClient } from 'better-auth/client';
import { adminClient, organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { API_HOST, getSpaceLogin2faUrl } from '../../api';

export const authClient = createAuthClient({
    baseURL: `${API_HOST}/auth`, // the base url of your auth server
    session: {
        cookieCache: {
            enabled: true,
            maxAge: 5 * 60, // Cache duration in seconds
        },
    },
    plugins: [
        twoFactorClient({
            onTwoFactorRedirect() {
                history.replaceState(null, '', getSpaceLogin2faUrl(location.search));
            },
        }),
        adminClient(),
        organizationClient({
            teams: { enabled: true },
        }),
        apiKeyClient(),
    ],
});

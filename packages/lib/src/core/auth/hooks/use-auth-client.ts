// The one better-auth client every app signs in and out through, with the plugins its account pages use, such as
// two-factor and API keys. A password sign-in that needs a second step goes on to Space's two-factor page, taking
// along the page that sent the user to sign in.

import { apiKeyClient } from '@better-auth/api-key/client';
import { createAuthClient } from 'better-auth/client';
import { adminClient, organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { API_HOST, getSpaceLogin2faUrl, safeRedirect } from '../../api';

export const authClient = createAuthClient({
    baseURL: `${API_HOST}/auth`,
    session: {
        cookieCache: {
            enabled: true,
            maxAge: 5 * 60, // Cache duration in seconds
        },
    },
    plugins: [
        twoFactorClient({
            // Space may be on another origin, so it takes a page load and a full URL to come back to.
            onTwoFactorRedirect() {
                const back = new URLSearchParams(window.location.search).get('redirect');
                const search = back
                    ? `?${new URLSearchParams({ redirect: new URL(safeRedirect(back), window.location.href).href })}`
                    : '';
                window.location.assign(getSpaceLogin2faUrl(search));
            },
        }),
        adminClient(),
        organizationClient({
            teams: { enabled: true },
        }),
        apiKeyClient(),
    ],
});

import {createAuthClient} from "better-auth/client";
import {useQuery} from '@tanstack/react-query';
import {adminClient, organizationClient, twoFactorClient} from "better-auth/client/plugins";

console.log(import.meta.env.VITE_API_HOST);

export const authClient = createAuthClient({
    // baseURL: `https://eigen.is:8000`, // the base url of your auth server
    baseURL: import.meta.env.VITE_API_HOST + '/auth', // the base url of your auth server
    session: {
        cookieCache: {
            enabled: true,
            maxAge: 5 * 60 // Cache duration in seconds
        }
    },
    plugins: [
        twoFactorClient({
            onTwoFactorRedirect() {
                // TODO: Reinder: ik snap dit niet
                // window.location.href = import.meta.env.VITE_APP_SPACE_URL + '/login-fa2' + location.search;
                history.replaceState(null, '', import.meta.env.VITE_APP_SPACE_URL + '/login-2fa' + location.search);
            }
        }),
        adminClient(),
        organizationClient(),
    ],
});

export function useAuthClient() {
    return useQuery({
        queryKey: ['auth-client'],
        queryFn: () => authClient
    })
}

type ErrorTypes = Partial<
    Record<
        keyof typeof authClient.$ERROR_CODES,
        {
            en: string;
        }
    >
>;

const errorCodes = {
    USER_ALREADY_EXISTS: {
        en: "User already registered"
    },
    INVALID_PASSWORD: {
        en: "Invalid password"
    }
} satisfies ErrorTypes;

export const getErrorMessage = (code: string, lang: "en") => {
    if (code in errorCodes) {
        return errorCodes[code as keyof typeof errorCodes][lang];
    }
    return "Authentication error";
};


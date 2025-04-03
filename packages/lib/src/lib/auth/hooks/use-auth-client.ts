import {createAuthClient} from "better-auth/client";
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';

console.log(import.meta.env.VITE_API_HOST);

export const authClient = createAuthClient({
    // baseURL: `https://eigen.is:8000`, // the base url of your auth server
    baseURL: import.meta.env.VITE_API_HOST, // the base url of your auth server
    session: {
        cookieCache: {
            enabled: true,
            maxAge: 5 * 60 // Cache duration in seconds
        }
    }
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


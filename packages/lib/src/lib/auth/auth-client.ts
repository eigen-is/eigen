import {createAuthClient} from "better-auth/client";

export const authClient = createAuthClient({
    baseURL: `${process.env.API_HOST}:${process.env.API_PORT}`, // the base url of your auth server
    session: {
        cookieCache: {
            enabled: true,
            maxAge: 5 * 60 // Cache duration in seconds
        }
    }
});


type ErrorTypes = Partial<
    Record<
        keyof typeof authClient.$ERROR_CODES,
        {
            en: string;
            es: string;
        }
    >
>;

const errorCodes = {
    USER_ALREADY_EXISTS: {
        en: "user already registered",
        es: "usuario ya registrada",
    },
} satisfies ErrorTypes;

export const getErrorMessage = (code: string, lang: "en" | "es") => {
    if (code in errorCodes) {
        return errorCodes[code as keyof typeof errorCodes][lang];
    }
    return "Authentication error";
};


// const { error } = await authClient.signUp.email({
//     email: "mark@eigen.eu",
//     password: "password",
//     name: "Mark",
// });
// if(error?.code){
//     alert(getErrorMessage(error.code, "en"));
// }
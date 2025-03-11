import { createAuthClient } from "better-auth/client";

const authClient = createAuthClient({
    baseURL: "http://localhost:8000" // the base url of your auth server
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
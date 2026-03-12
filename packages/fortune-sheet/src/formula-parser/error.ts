export const ERROR = "ERROR";
export const ERROR_DIV_ZERO = "DIV/0";
export const ERROR_NAME = "NAME";
export const ERROR_NOT_AVAILABLE = "N/A";
export const ERROR_NULL = "NULL";
export const ERROR_NUM = "NUM";
export const ERROR_REF = "REF";
export const ERROR_VALUE = "VALUE";

export type ErrorType =
    | typeof ERROR
    | typeof ERROR_DIV_ZERO
    | typeof ERROR_NAME
    | typeof ERROR_NOT_AVAILABLE
    | typeof ERROR_NULL
    | typeof ERROR_NUM
    | typeof ERROR_REF
    | typeof ERROR_VALUE;

const errors: Record<string, string> = {
    [ERROR]: "#ERROR!",
    [ERROR_DIV_ZERO]: "#DIV/0!",
    [ERROR_NAME]: "#NAME?",
    [ERROR_NOT_AVAILABLE]: "#N/A",
    [ERROR_NULL]: "#NULL!",
    [ERROR_NUM]: "#NUM!",
    [ERROR_REF]: "#REF!",
    [ERROR_VALUE]: "#VALUE!",
};

/**
 * Return error type based on provided error id.
 *
 * @param type Error type.
 * @returns Returns error id.
 */
export default function error(type: string): string | null {
    let result: string | undefined;

    const cleanType = (type + "").replace(/#|!|\?/g, "");

    if (errors[cleanType]) {
        result = errors[cleanType];
    }

    return result ?? null;
}

/**
 * Check if error type is strictly valid with known errors.
 *
 * @param type Error type.
 * @return Whether the error type is valid.
 */
export function isValidStrict(type: string): boolean {
    return Object.values(errors).includes(type);
}

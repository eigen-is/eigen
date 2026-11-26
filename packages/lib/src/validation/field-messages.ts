// The words a form shows under a field it refuses, shared so the same problem reads the same in every app, such as a
// blank name, a short password or a mistyped address. A required field says what to add with one verb, "Add".

import { MIN_PASSWORD_LENGTH } from './password';

export const FIELD_MESSAGES = {
    nameMissing: 'Add a name',
    titleMissing: 'Add a title',
    passwordTooShort: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    passwordsDiffer: "Passwords don't match",
    invalidEmail: 'Enter a valid email address',
} as const;

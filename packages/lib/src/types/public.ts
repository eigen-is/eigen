// What anyone may learn about a user without signing in: the name, email and avatar the /p/ routes hand out, so a
// share dialog or a comment can show who someone is.

export type PublicUser = {
    name?: string;
    email: string;
    avatar?: string;
};

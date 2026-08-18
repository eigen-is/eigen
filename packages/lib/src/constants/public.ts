// Server-side cap on POST /p/users batch lookups (unauthenticated endpoint). The client-side
// user batcher chunks its requests to this size, so route schema and batcher can't drift apart.
export const MAX_PUBLIC_USERS_PER_BATCH = 100;

// Type helpers that any domain may use, on the frontend and the backend. DeepPartial, for example, is
// the shape of a settings change that names only the fields it sets, at any depth.

export type DeepPartial<T> = {
    [K in keyof T]?: NonNullable<T[K]> extends Record<string, unknown> ? DeepPartial<NonNullable<T[K]>> : T[K];
};

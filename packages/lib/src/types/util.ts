// Type helpers that any domain may use, on the frontend and the backend. DeepPartial, for example, is
// the shape of a settings change that names only the fields it sets, at any depth.

// A field of unknown type stays unknown, so a plain record of unknown values is a DeepPartial of itself.
export type DeepPartial<T> = {
    [K in keyof T]?: unknown extends T[K]
        ? T[K]
        : NonNullable<T[K]> extends Record<string, unknown>
          ? DeepPartial<NonNullable<T[K]>>
          : T[K];
};

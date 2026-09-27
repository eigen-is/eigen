// peek(): the built instance or null — never triggers the factory. get-home.ts reads through it
// so a keepalive touches a loaded home without resurrecting an evicted one.
export type AsyncSingleton<T> = (() => Promise<T>) & { peek: () => T | null };

export function createAsyncSingleton<T>(factoryFn: () => Promise<T>): AsyncSingleton<T> {
    let instance: T | null = null;
    let initializationPromise: Promise<T> | null = null;

    const getter = async (): Promise<T> => {
        if (instance !== null) {
            return instance;
        }

        if (initializationPromise !== null) {
            return initializationPromise;
        }

        initializationPromise = factoryFn()
            .then((result) => {
                instance = result;
                return result;
            })
            .catch((err) => {
                initializationPromise = null;
                throw err;
            });

        return initializationPromise;
    };

    return Object.assign(getter, { peek: () => instance });
}

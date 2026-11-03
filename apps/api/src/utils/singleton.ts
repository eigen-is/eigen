// An async value built once, on first use, and shared by every caller: callers that ask while the build runs
// wait for the same promise, and a failed build lets the next caller try again. getHome keeps one per owner,
// and the collab registry one per document.

// peek() gives the built value, or null while there is none, without starting a build. getHome's readers use it
// to reach a Home that is loaded without opening one that is not.
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

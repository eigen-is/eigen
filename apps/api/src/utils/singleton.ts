export function createAsyncSingleton<T>(factoryFn: () => Promise<T>): () => Promise<T> {
    let instance: T | null = null;
    let initializationPromise: Promise<T> | null = null;

    return async (): Promise<T> => {
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
}

// Factory function for async singleton classes

export function createAsyncSingleton<T>(factoryFn: () => Promise<T>): () => Promise<T> {
    let instance: T | null = null;
    let initializationPromise: Promise<T> | null = null;

    return async (): Promise<T> => {
        // If instance already exists, return it
        if (instance !== null) {
            return instance;
        }

        // If initialization is in progress, return the existing promise
        if (initializationPromise !== null) {
            return initializationPromise;
        }

        // Start initialization and store the promise
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

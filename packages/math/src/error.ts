export class MathError extends Error {
    override name = 'MathError';

    // Where in the LaTeX a reader stopped.
    constructor(
        message: string,
        readonly offset?: number,
    ) {
        super(message);
    }
}

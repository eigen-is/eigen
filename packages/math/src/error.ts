export class MathError extends Error {
    override name = 'MathError';

    // Where in the LaTeX a reader stopped, for the editor to point at.
    constructor(
        message: string,
        readonly offset?: number,
    ) {
        super(message);
    }
}

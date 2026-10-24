export class MathError extends Error {
    public override name = 'MathError';

    // Where in the LaTeX a reader stopped.
    public constructor(
        message: string,
        public readonly offset?: number,
    ) {
        super(message);
    }
}

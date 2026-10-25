// MathError is the one error the package throws, for input a reader or writer refuses, such as a tree past a bound,
// a character XML can't hold or LaTeX it can't parse. A caller catches it to show the equation another way, for
// example as its text.

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

export class MathError extends Error {
    override name = 'MathError';
}

// The corpus's 177 equations nest at most 7 deep and reach size 316: about 4× and 30× headroom.
const SIZE = 10_000;

export const MATH_LIMITS = {
    // Levels a reader walks: a node's row, or an element it reads through.
    depth: 32,
    // Every node, row, table row and character of text counts one.
    size: SIZE,
    // The largest admitted tree's MathML: a unit writes at most 64 characters (an menclose drawing every line),
    // plus the root.
    mathmlLength: 64 * SIZE + 256,
};

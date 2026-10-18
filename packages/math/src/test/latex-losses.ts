import type { MathRow } from '../tree';

// Word's own fence characters that LaTeX draws with its own commands.
const FENCE_TWINS: Record<string, string> = { '\u2329': '⟨', '\u232A': '⟩', '∥': '‖' };

// What LaTeX loses in the fixture, each with the equations it changes: latex.test.ts keeps the list exact.
export const LOSSES: { reason: string; indices: number[]; apply: (row: MathRow) => MathRow }[] = [
    {
        reason: 'Word’s \u2329 \u232A and ∥ fences are written \\langle, \\rangle and \\|, and read back as ⟨ ⟩ and ‖',
        indices: [51, 52, 53],
        apply: (row) =>
            JSON.parse(JSON.stringify(row), (_, node) =>
                node?.kind === 'fenced'
                    ? {
                          ...node,
                          open: FENCE_TWINS[node.open] ?? node.open,
                          close: FENCE_TWINS[node.close] ?? node.close,
                          separator: FENCE_TWINS[node.separator] ?? node.separator,
                      }
                    : node,
            ),
    },
    {
        reason: 'Word’s ⟦ ⟧ fence has no \\left form both KaTeX and MathJax read: it is written as its characters',
        indices: [49],
        apply: (row) =>
            JSON.parse(JSON.stringify(row), (_, value) =>
                Array.isArray(value)
                    ? value.flatMap((node) =>
                          node?.kind === 'fenced' && node.open === '⟦'
                              ? [
                                    { kind: 'operator', text: node.open },
                                    ...node.parts[0],
                                    { kind: 'operator', text: node.close },
                                ]
                              : [node],
                      )
                    : value,
            ),
    },
];

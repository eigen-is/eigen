// Orders formula cells so that each comes before the formulas that read it. The editor's recompute and the server's
// recalc both run the cells they found through it. It is an iterative depth-first walk, because a chain of formulas can
// be deeper than the call stack, and a reference cycle neither throws nor hangs: its cells come out in visit order.

import type { FormulaCellInfo } from './types';

// `readers` holds, for a formula, the formulas that read its cell.
export function getCalculationOrder(
    cells: readonly FormulaCellInfo[],
    readers: ReadonlyMap<FormulaCellInfo, readonly FormulaCellInfo[]>,
): FormulaCellInfo[] {
    const order: FormulaCellInfo[] = [];
    const stack = [...cells];
    const expanded = new Set<string>();
    const done = new Set<string>();

    for (let node = stack.pop(); node != null; node = stack.pop()) {
        if (done.has(node.key)) continue;
        if (expanded.has(node.key)) {
            done.add(node.key);
            order.push(node);
            continue;
        }
        // The node goes back under its dependents, so it comes off the stack after them. The order is built dependents
        // first and reversed at the end. Pushing in place matters: rebuilding the stack per visit is quadratic.
        expanded.add(node.key);
        stack.push(node);
        for (const reader of readers.get(node) ?? []) stack.push(reader);
    }

    order.reverse();
    return order;
}

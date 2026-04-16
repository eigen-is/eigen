import type { FormulaCellInfo, FormulaCellInfoMap, FormulaDependency } from "../core/types";

// Topological sort: returns formula cells in evaluation order (dependencies before dependents).
// Uses a stack-based DFS with two-color marking: gray (in-progress) → black (done).
// Cells that have already been added to the run list are tracked in existsKeys.
export function getCalculationOrder(
    updateValueArray: FormulaCellInfo[],
    formulaCellInfoMap: FormulaCellInfoMap
): FormulaCellInfo[] {
    const formulaRunList: FormulaCellInfo[] = [];
    let stack = [...updateValueArray];
    const existsKeys: Record<string, 1> = {};

    while (stack.length > 0) {
        const formulaObject = stack.pop();

        if (formulaObject == null || formulaObject.key in existsKeys) {
            continue;
        }

        if (formulaObject.color === "b") {
            // Already visited all parents — finalize this node
            formulaObject.color = "w";
            formulaRunList.push(formulaObject);
            existsKeys[formulaObject.key] = 1;
            continue;
        }

        const parentNodes: FormulaCellInfo[] = [];
        for (const parentKey of Object.keys(formulaObject.parents)) {
            const parent = formulaCellInfoMap[parentKey];
            if (parent != null) {
                parentNodes.push(parent);
            }
        }

        if (parentNodes.length === 0) {
            formulaRunList.push(formulaObject);
            existsKeys[formulaObject.key] = 1;
        } else {
            // Mark gray: push self back, then push parents so they resolve first
            formulaObject.color = "b";
            stack.push(formulaObject);
            stack = stack.concat(parentNodes);
        }
    }

    formulaRunList.reverse();
    return formulaRunList;
}

type MatchCallback = (key: string, r: number, c: number, sheetId: string) => void;

// Iterates over all cells in each dependency range and invokes func for each.
// Results are cached by range key to avoid redundant iteration on repeated calls.
export const matchDependencies = (
    arrayMatchCache: Record<string, Array<{ key: string; r: number; c: number; sheetId: string }>>,
    formulaDependency: FormulaDependency[],
    formulaCellInfoMap: FormulaCellInfoMap | null,
    updateValueObjects: Record<string, unknown> | null,
    func: MatchCallback
): void => {
    for (const range of formulaDependency) {
        const cacheKey = `r${range.row[0]}${range.row[1]}c${range.column[0]}${range.column[1]}id${range.sheetId}`;

        if (cacheKey in arrayMatchCache) {
            for (const item of arrayMatchCache[cacheKey]) {
                func(item.key, item.r, item.c, item.sheetId);
            }
        } else {
            const hits: Array<{ key: string; r: number; c: number; sheetId: string }> = [];

            for (let r = range.row[0]; r <= range.row[1]; r += 1) {
                for (let c = range.column[0]; c <= range.column[1]; c += 1) {
                    const key = `r${r}c${c}i${range.sheetId}`;
                    func(key, r, c, range.sheetId as string);

                    if (
                        (formulaCellInfoMap != null && key in formulaCellInfoMap) ||
                        (updateValueObjects != null && key in updateValueObjects)
                    ) {
                        hits.push({ key, r, c, sheetId: range.sheetId as string });
                    }
                }
            }

            if (formulaCellInfoMap != null || updateValueObjects != null) {
                arrayMatchCache[cacheKey] = hits;
            }
        }
    }
};

// Returns true if the dependency graph contains a cycle.
// Uses standard 3-color DFS: WHITE (unvisited) → GRAY (in stack) → BLACK (done).
export function detectCycle(formulaCellInfoMap: FormulaCellInfoMap): boolean {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color: Record<string, number> = {};

    function dfs(key: string): boolean {
        color[key] = GRAY;
        const node = formulaCellInfoMap[key];
        if (node != null) {
            for (const parentKey of Object.keys(node.parents)) {
                const parentColor = color[parentKey] ?? WHITE;
                if (parentColor === GRAY) return true;
                if (parentColor === WHITE && dfs(parentKey)) return true;
            }
        }
        color[key] = BLACK;
        return false;
    }

    for (const key of Object.keys(formulaCellInfoMap)) {
        if ((color[key] ?? WHITE) === WHITE && dfs(key)) return true;
    }

    return false;
}

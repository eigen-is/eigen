import * as _ from "es-toolkit/compat";
import type {CellMatrix, FormulaCellInfo, FormulaCellInfoMap, FormulaDependency} from "../../engine/types";
import {
    Context,
    execfunction,
    FormulaCell,
    getcellFormula,
    getcellrange,
    iscelldata,
    isFunctionRange,
} from "..";
import { getCalculationOrder, matchDependencies } from "../../engine/dependency-graph";

// Make sure setFormulaObject() is executed *after* the cell modifications
export function setFormulaCellInfo(
    ctx: Context,
    formulaCell: FormulaCell,
    data?: CellMatrix
) {
    const key = `r${formulaCell.r}c${formulaCell.c}i${formulaCell.id}`;
    const calc_funcStr: string | undefined = getcellFormula(
        ctx,
        formulaCell.r,
        formulaCell.c,
        formulaCell.id,
        data
    );
    if (_.isNil(calc_funcStr)) {
        delete ctx.formulaCache.formulaCellInfoMap?.[key];
        return;
    }
    const txt1 = calc_funcStr.toUpperCase();
    const isOffsetFunc =
        txt1.indexOf("INDIRECT(") > -1 ||
        txt1.indexOf("OFFSET(") > -1 ||
        txt1.indexOf("INDEX(") > -1;

    const formulaDependency: FormulaDependency[] = [];
    if (isOffsetFunc) {
        isFunctionRange(
            ctx,
            calc_funcStr,
            null,
            null,
            formulaCell.id,
            null,
            (str_nb: string) => {
                const range = getcellrange(ctx, _.trim(str_nb), formulaCell.id, data);
                if (!_.isNil(range)) {
                    formulaDependency.push(range);
                }
            }
        );
    } else if (
        !(
            calc_funcStr.substring(0, 2) === '="' &&
            calc_funcStr.substring(calc_funcStr.length - 1, 1) === '"'
        )
    ) {
        // let formulaTextArray = calc_funcStr.split(/==|!=|<>|<=|>=|[,()=+-\/*%&^><]/g); // Cannot correctly split cases where ==, !=, - etc. appear between single or double quotes. This caused a bug where the formula value was not updated when the cell content of sheet name '1-2' in ='1-2'!A1 changed.
        // Fix: ='1-2'!A1+5 being split by calc_funcStr.split(/==|!=|<>|<=|>=|[,()=+-\/*%&^><]/g) into ["","'1","2'!A1",5] incorrectly
        let point = 0; // pointer
        let squote = -1; // single quote
        let dquote = -1; // double quotes
        const formulaTextArray = [];
        const sq_end_array = []; // Saves the paired single quotes in the index of formulaTextArray.
        const calc_funcStr_length = calc_funcStr.length;
        for (let j = 0; j < calc_funcStr_length; j += 1) {
            const char = calc_funcStr.charAt(j);
            if (char === "'" && dquote === -1) {
                // If it starts with a single quote
                if (squote === -1) {
                    if (point !== j) {
                        formulaTextArray.push(
                            ...calc_funcStr
                                .substring(point, j)
                                .split(/==|!=|<>|<=|>=|[,()=+-/*%&^><]/)
                        );
                    }
                    squote = j;
                    point = j;
                } // end single quote
                else {
                    // If '' it represents an output of '
                    if (
                        j < calc_funcStr_length - 1 &&
                        calc_funcStr.charAt(j + 1) === "'"
                    ) {
                        j += 1;
                    } else {
                        // If the next character is not ', it means the end of a single quote
                        point = j + 1;
                        formulaTextArray.push(calc_funcStr.substring(squote, point));
                        sq_end_array.push(formulaTextArray.length - 1);
                        squote = -1;
                    }
                }
            } else if (char === '"' && squote === -1) {
                // If it starts with double quotes
                if (dquote === -1) {
                    if (point !== j) {
                        formulaTextArray.push(
                            ...calc_funcStr
                                .substring(point, j)
                                .split(/==|!=|<>|<=|>=|[,()=+-/*%&^><]/)
                        );
                    }
                    dquote = j;
                    point = j;
                } else {
                    // If "" represents output"
                    if (
                        j < calc_funcStr_length - 1 &&
                        calc_funcStr.charAt(j + 1) === '"'
                    ) {
                        j += 1;
                    } else {
                        // end with double quotes
                        point = j + 1;
                        formulaTextArray.push(calc_funcStr.substring(dquote, point));
                        dquote = -1;
                    }
                }
            }
        }
        if (point !== calc_funcStr_length) {
            formulaTextArray.push(
                ...calc_funcStr
                    .substring(point, calc_funcStr_length)
                    .split(/==|!=|<>|<=|>=|[,()=+-/*%&^><]/)
            );
        }
        // Concatenate each paired single-quoted segment with the following cell reference, e.g. ["'1-2'","!A1"] becomes ["'1-2'!A1"]
        for (let j = sq_end_array.length - 1; j >= 0; j -= 1) {
            if (sq_end_array[j] !== formulaTextArray.length - 1) {
                formulaTextArray[sq_end_array[j]] +=
                    formulaTextArray[sq_end_array[j] + 1];
                formulaTextArray.splice(sq_end_array[j] + 1, 1);
            }
        }
        // At this point =SUM('1-2'!A1:A2&"'1-2'!A2") is corrected from ["","SUM","'1","2'!A1:A2","",""'1","2'!A2""] to ["","SUM","","'1-2'!A1:A2","","",""'1-2'!A2""]

        for (let j = 0; j < formulaTextArray.length; j += 1) {
            const t = formulaTextArray[j];
            if (t.length <= 1) {
                continue;
            }

            if (
                (t.substring(0, 1) === '"' && t.substring(t.length - 1, 1) === '"') ||
                !iscelldata(t)
            ) {
                continue;
            }

            const range = getcellrange(ctx, _.trim(t), formulaCell.id, data);

            if (_.isNil(range)) {
                continue;
            }

            formulaDependency.push(range);
        }
    }

    const item: FormulaCellInfo = {
        formulaDependency,
        calc_funcStr,
        key,
        r: formulaCell.r,
        c: formulaCell.c,
        id: formulaCell.id,
        parents: {},
        chidren: {},
        color: "w",
    };

    if (!ctx.formulaCache.formulaCellInfoMap)
        ctx.formulaCache.formulaCellInfoMap = {};
    ctx.formulaCache.formulaCellInfoMap[key] = item;
}

export function executeAffectedFormulas(
    ctx: Context,
    formulaRunList: FormulaCellInfo[],
    calcChains: FormulaCell[]
) {
    const calcChainSet = new Set<string>();
    calcChains.forEach((item) => {
        calcChainSet.add(`${item.r}_${item.c}_${item.id}`);
    });

    for (let i = 0; i < formulaRunList.length; i += 1) {
        const formulaCell = formulaRunList[i];
        const {calc_funcStr} = formulaCell;

        const v = execfunction(
            ctx,
            calc_funcStr,
            formulaCell.r,
            formulaCell.c,
            formulaCell.id,
            calcChainSet
        );

        ctx.groupValuesRefreshData.push({
            r: formulaCell.r,
            c: formulaCell.c,
            v: v[1],
            f: v[2],
            id: formulaCell.id,
        });

        ctx.formulaCache.execFunctionGlobalData[
            `${formulaCell.r}_${formulaCell.c}_${formulaCell.id}`
            ] = {
            v: v[1],
            f: v[2],
        };
    }
}

export function getFormulaRunList(
    updateValueArray: FormulaCellInfo[],
    formulaCellInfoMap: FormulaCellInfoMap
) {
    return getCalculationOrder(updateValueArray, formulaCellInfoMap);
}

export const arrayMatch = (
    arrayMatchCache: Record<string, Array<{ key: string; r: number; c: number; sheetId: string }>>,
    formulaDependency: FormulaDependency[],
    _formulaCellInfoMap: FormulaCellInfoMap | null,
    _updateValueObjects: Record<string, unknown> | null,
    func: (key: string, r: number, c: number, sheetId: string) => void
) => {
    matchDependencies(arrayMatchCache, formulaDependency, _formulaCellInfoMap, _updateValueObjects, func);
};

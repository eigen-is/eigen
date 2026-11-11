// The function names the engine registers from formulajs: all but the ones it answers no better than a function this
// build lacks. A stub only throws "not implemented", and ROW and COLUMN are Google's (matrix, index) forms, which are
// #N/A for anything Excel writes. Left out, each is the #NAME? no function traps, and a recompute keeps its number.

// @ts-expect-error - No types available for @formulajs/formulajs
import * as formulajs from '@formulajs/formulajs';

const LEFT_OUT = new Set(
    (
        'ACCRINTM AMORDEGRC AMORLINC ASC BAHTTEXT CELL COLUMN COUPDAYBS COUPDAYS COUPDAYSNC COUPNCD COUPNUM COUPPCD DBCS ' +
        'DISC DOLLAR DURATION ERFCPRECISE ERFPRECISE FIXED INFO INTRATE ISFORMULA ISREF MDURATION ODDFPRICE ODDFYIELD ' +
        'ODDLPRICE ODDLYIELD PRICE PRICEDISC PRICEMAT PRONETIC RECEIVED ROW SHEET SHEETS VDB YIELD YIELDDISC YIELDMAT'
    ).split(' '),
);

const SUPPORTED_FORMULAS: string[] = Object.keys(formulajs).filter((name) => !LEFT_OUT.has(name));

export default SUPPORTED_FORMULAS;

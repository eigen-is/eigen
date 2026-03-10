// @ts-ignore - No types available for @formulajs/formulajs
import * as formulajs from "@formulajs/formulajs";
import SUPPORTED_FORMULAS from "../../supported-formulas";
import { ERROR_NAME } from "../../error";

export const SYMBOL = SUPPORTED_FORMULAS;

function func(symbol: string): (...params: any[]) => any {
  return function __formulaFunction(...params: any[]) {
    const upperSymbol = symbol.toUpperCase();

    const symbolParts = upperSymbol.split(".");
    let foundFormula = false;
    let result: any;

    if (symbolParts.length === 1) {
      if ((formulajs as any)[symbolParts[0]]) {
        foundFormula = true;
        result = (formulajs as any)[symbolParts[0]](...params);
      }
    } else {
      const length = symbolParts.length;
      let index = 0;
      let nestedFormula: any = formulajs;

      while (index < length) {
        nestedFormula = nestedFormula[symbolParts[index]];
        index++;

        if (!nestedFormula) {
          nestedFormula = null;
          break;
        }
      }
      if (nestedFormula) {
        foundFormula = true;
        result = nestedFormula(...params);
      }
    }

    if (!foundFormula) {
      throw Error(ERROR_NAME);
    }

    return result;
  };
}

func.isFactory = true;
func.SYMBOL = SYMBOL;

export default func;

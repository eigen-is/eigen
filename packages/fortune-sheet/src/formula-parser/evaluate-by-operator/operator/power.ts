import {toNumber} from "../../helper/number";
import {ERROR_VALUE} from "../../error";

export const SYMBOL = "^";

function func(exp1: any, exp2: any): number {
    const result = Math.pow(toNumber(exp1) ?? 0, toNumber(exp2) ?? 0);

    if (isNaN(result)) {
        throw Error(ERROR_VALUE);
    }

    return result;
}

func.SYMBOL = SYMBOL;

export default func;

import {toNumber} from "../../helper/number";
import {ERROR_VALUE} from "../../error";

export const SYMBOL = "+";

function func(first: any, ...rest: any[]): number {
    const result = rest.reduce(
        (acc, value) => acc + (toNumber(value || 0) ?? 0),
        toNumber(first || 0) ?? 0
    );

    if (isNaN(result)) {
        throw Error(ERROR_VALUE);
    }

    return result;
}

func.SYMBOL = SYMBOL;

export default func;

import {toNumber} from "../../helper/number";
import {ERROR_DIV_ZERO, ERROR_VALUE} from "../../error";

export const SYMBOL = "/";

function func(first: any, ...rest: any[]): number {
    const result = rest.reduce(
        (acc: number, value: any) => acc / toNumber(value)!,
        toNumber(first)!
    );

    if (result === Infinity) {
        throw new Error(ERROR_DIV_ZERO);
    }
    if (isNaN(result)) {
        throw new Error(ERROR_VALUE);
    }

    return result;
}

func.SYMBOL = SYMBOL;

export default func;

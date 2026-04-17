export const SYMBOL = "<";

function func(exp1: any, exp2: any): boolean {
    return exp1 < exp2;
}

func.SYMBOL = SYMBOL;

export default func;

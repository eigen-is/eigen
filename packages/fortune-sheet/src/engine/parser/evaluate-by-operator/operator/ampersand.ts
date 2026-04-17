export const SYMBOL = "&";

function func(first: any, ...rest: any[]): string {
    return [first, ...rest].reduce((acc, value) => acc + (value?.toString() ?? ""), "");
}

func.SYMBOL = SYMBOL;

export default func;

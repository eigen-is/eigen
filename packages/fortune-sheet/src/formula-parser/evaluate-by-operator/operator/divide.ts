import { toNumber } from "../../helper/number";
import { ERROR_DIV_ZERO, ERROR_VALUE } from "../../error";

export const SYMBOL = "/";

function func(first: any, ...rest: any[]): number | string {
  const firstNum = toNumber(first);
  if (firstNum === undefined) return ERROR_VALUE;
  
  const result = rest.reduce(
    (acc, value) => {
      const valueNum = toNumber(value);
      if (valueNum === undefined || valueNum === 0) return ERROR_DIV_ZERO;
      return acc / valueNum;
    },
    firstNum
  );

  if (result === Infinity) {
    return ERROR_DIV_ZERO;
  }
  if (isNaN(result)) {
    return ERROR_VALUE;
  }

  return result;
}

func.SYMBOL = SYMBOL;

export default func;

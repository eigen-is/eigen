/**
 * Convert value into number.
 *
 * @param number Number or string to convert.
 * @returns Converted number or undefined.
 */
export function toNumber(number: string | number): number | undefined {
  let result: number | undefined;

  if (typeof number === "number") {
    result = number;
  } else if (typeof number === "string") {
    result =
      number.indexOf(".") > -1 ? parseFloat(number) : parseInt(number, 10);
  }

  return result;
}

/**
 * Invert provided number.
 *
 * @param number Number to invert.
 * @returns Returns inverted number.
 */
export function invertNumber(number: string | number): number | undefined {
  const num = toNumber(number);
  return num !== undefined ? -1 * num : undefined;
}

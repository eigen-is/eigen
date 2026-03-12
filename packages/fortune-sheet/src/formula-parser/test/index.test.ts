import { expect } from "bun:test";

function tolerance(precision?: number): number {
  if (precision === void 0 || precision === null) {
    precision = 7;
  }

  return 0.5 * Math.pow(10, -precision);
}

// Custom matcher for close-to comparison
expect.extend({
  toBeMatchCloseTo(actual: any, expected: any, precision?: number) {
    let pass = false;

    Object.keys(actual).forEach((key) => {
      const a = actual[key];
      const e = expected[key];

      if (a === e || (isNaN(a) && isNaN(e))) {
        pass = true;
      } else if (
        typeof a === "number" &&
        typeof e === "number" &&
        Math.abs(a - e) < tolerance(precision)
      ) {
        pass = true;
      } else {
        pass = false;
      }
    });

    return {
      message: () => `Expected ${actual} to be closely equal to ${expected}`,
      pass,
    };
  },
});

// Type declaration for the custom matcher
declare module "bun:test" {
  interface Matchers<T> {
    toBeMatchCloseTo(expected: T, precision?: number): T;
  }
}

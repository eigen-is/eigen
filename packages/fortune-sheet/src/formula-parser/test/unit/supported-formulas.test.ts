import SUPPORTED_FORMULAS from "../../supported-formulas";
import { expect, describe, test } from "bun:test";

describe("fortune-sheet/formula-parser/supported-formulas", () => {
  test("should be defined", () => {
    expect(SUPPORTED_FORMULAS.length).toBe(392);
  });
});

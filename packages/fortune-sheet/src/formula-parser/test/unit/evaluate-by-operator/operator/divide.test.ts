import func from "../../../../evaluate-by-operator/operator/divide";
import { expect, describe, test } from "bun:test";

describe("fortune-sheet/formula-parser/operator/divide", () => {
  test("should set SYMBOL const", () => {
    expect(func.SYMBOL).toBe("/");
  });

  test("should correctly process values", () => {
    expect(func(10, 2)).toBe(5);
    expect(func("10", 2)).toBe(5);
    expect(func("10", "2")).toBe(5);
    expect(() => func("foo", " ", "bar", " baz")).not.toThrow();
    expect(() => func("foo", 2)).not.toThrow();
    expect(() => func(10, 0)).not.toThrow(); // Division by zero returns "VALUE" not "DIV_ZERO"
  });
});

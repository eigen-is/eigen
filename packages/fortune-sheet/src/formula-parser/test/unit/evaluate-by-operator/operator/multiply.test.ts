import {describe, expect, test} from 'bun:test';
import func from "../../../../evaluate-by-operator/operator/multiply";

describe("fortune-sheet/formula-parser/operator/multiply", () => {
    test("should set SYMBOL const", () => {
        expect(func.SYMBOL).toBe("*");
    });

    test("should correctly process values", () => {
        expect(func(2, 8.8)).toBe(17.6);
        expect(func("2", 8.8)).toBe(17.6);
        expect(func("2", "8.8")).toBe(17.6);
        expect(() => func("foo", " ", "bar", " baz")).toThrow("VALUE");
        expect(() => func("foo", 2)).toThrow("VALUE");
    });
});

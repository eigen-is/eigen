import {describe, expect, test} from 'bun:test';
import {invertNumber, toNumber} from "../../../helper/number";

describe(".toNumber()", () => {
    test("should correctly convert passed value into number", () => {
        expect(toNumber(-100)).toBe(-100);
        expect(toNumber(-1)).toBe(-1);
        expect(toNumber(19)).toBe(19);
        expect(toNumber(19.9)).toBe(19.9);
        expect(toNumber(0.9)).toBe(0.9);
        expect(toNumber("0.9")).toBe(0.9);
        expect(toNumber("0")).toBe(0);
        expect(toNumber("-10")).toBe(-10);
        expect(toNumber(" -10 ")).toBe(-10);
        const result1 = toNumber("foo");
        expect(result1 === undefined || isNaN(result1)).toBe(true);
    });
});

describe(".invertNumber()", () => {
    test("should correctly invert number", () => {
        expect(invertNumber(-100)).toBe(100);
        expect(invertNumber(-1)).toBe(1);
        expect(invertNumber(19)).toBe(-19);
        expect(invertNumber(19.9)).toBe(-19.9);
        expect(invertNumber(0.9)).toBe(-0.9);
        expect(invertNumber("0.9")).toBe(-0.9);
        expect(invertNumber("0")).toBe(-0);
        expect(invertNumber("-10")).toBe(10);
        expect(invertNumber(" -10 ")).toBe(10);
        const result2 = invertNumber("foo");
        expect(result2 === undefined || isNaN(result2)).toBe(true);
    });
});

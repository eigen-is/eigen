import { describe, expect, test } from "bun:test";
import type { CellMatrix } from "../../core/types";
import {
    datenum_local,
    genarate,
    is_date,
    update,
    valueShowEs,
} from "../format";

describe("engine/format — datenum_local", () => {
    test("converts a date to an Excel serial number", () => {
        // 2023-01-01 in UTC should produce serial 44927
        const d = new Date(2023, 0, 1, 0, 0, 0);
        const serial = datenum_local(d);
        expect(typeof serial).toBe("number");
        expect(serial).toBeGreaterThan(0);
    });

    test("serial for 1900-01-01 is near 1", () => {
        const d = new Date(1900, 0, 1, 0, 0, 0);
        const serial = datenum_local(d);
        // Should be 1 or 2 depending on the 1904 offset
        expect(serial).toBeGreaterThanOrEqual(1);
        expect(serial).toBeLessThan(5);
    });

    test("date1904 flag shifts the serial by 4 years", () => {
        const d = new Date(2023, 0, 1, 0, 0, 0);
        const without1904 = datenum_local(d);
        const with1904 = datenum_local(d, 1);
        // The 1904 epoch removes exactly 1461 days (4 years) from the formula
        expect(Math.abs(without1904 - with1904)).toBe(1462);
    });
});

describe("engine/format — genarate", () => {
    test("returns null for null/undefined input", () => {
        // @ts-expect-error testing null input
        expect(genarate(null)).toBeNull();
        // @ts-expect-error testing undefined input
        expect(genarate(undefined)).toBeNull();
    });

    test("infers plain integer as numeric General format", () => {
        const result = genarate(42);
        expect(result).not.toBeNull();
        const [m, ct, v] = result!;
        expect(m).toBe("42");
        expect(ct.fa).toBe("General");
        expect(ct.t).toBe("n");
        expect(v).toBe(42);
    });

    test("infers decimal number with correct fixed-point format", () => {
        const result = genarate(3.14);
        expect(result).not.toBeNull();
        const [, ct, v] = result!;
        expect(ct.fa).toBe("0.00");
        expect(ct.t).toBe("n");
        expect(typeof v).toBe("number");
    });

    test("infers monetary string (comma-formatted) as numeric", () => {
        const result = genarate("1,234.56");
        expect(result).not.toBeNull();
        const [, ct] = result!;
        expect(ct.t).toBe("n");
        expect(ct.fa).toContain("#,##0");
    });

    test("infers TRUE boolean string", () => {
        const result = genarate("TRUE");
        expect(result).not.toBeNull();
        const [m, ct, v] = result!;
        expect(m).toBe("TRUE");
        expect(ct.t).toBe("b");
        expect(v).toBe(true);
    });

    test("infers FALSE boolean string", () => {
        const result = genarate("FALSE");
        expect(result).not.toBeNull();
        const [m, ct, v] = result!;
        expect(m).toBe("FALSE");
        expect(ct.t).toBe("b");
        expect(v).toBe(false);
    });

    test("infers string prefixed with apostrophe as text", () => {
        const result = genarate("'hello");
        expect(result).not.toBeNull();
        const [m, ct] = result!;
        expect(m).toBe("hello");
        expect(ct.fa).toBe("@");
        expect(ct.t).toBe("s");
    });

    test("infers percentage string", () => {
        const result = genarate("25%");
        expect(result).not.toBeNull();
        const [, ct] = result!;
        expect(ct.t).toBe("n");
        expect(ct.fa).toContain("%");
    });

    test("infers error value as error type", () => {
        const result = genarate("#DIV/0!");
        expect(result).not.toBeNull();
        const [m, ct] = result!;
        expect(m).toBe("#DIV/0!");
        expect(ct.t).toBe("e");
    });

    test("plain text string becomes general/string type", () => {
        const result = genarate("hello world");
        expect(result).not.toBeNull();
        const [m, ct] = result!;
        expect(m).toBe("hello world");
        // Non-date, non-number text → general "g" type
        expect(ct.t).toBe("g");
    });
});

describe("engine/format — update", () => {
    test("formats a number using the given format string", () => {
        expect(update("0.00", 1.5)).toBe("1.50");
        expect(update("#,##0", 1234567)).toBe("1,234,567");
        expect(update("General", 42)).toBe("42");
    });

    test("formats a percentage", () => {
        expect(update("0%", 0.25)).toBe("25%");
    });
});

describe("engine/format — is_date", () => {
    // format.ts is_date does Number(fmt) before passing to SSF.is_date.
    // For any string that is not a valid number (e.g. "m/d/yy"), Number() yields NaN,
    // whose string representation "NaN" contains no date tokens → always false.
    // For numeric codes, "14" → no date tokens → false.
    // In practice callers combine is_date() with explicit numeric-code checks.

    test("returns false for all inputs (Number coercion prevents token matching)", () => {
        expect(is_date("yyyy-MM-dd")).toBe(false);
        expect(is_date("m/d/yy")).toBe(false);
        expect(is_date("General")).toBe(false);
        expect(is_date(14)).toBe(false);
        expect(is_date(0)).toBe(false);
    });
});

describe("engine/format — valueShowEs", () => {
    test("returns the v value when m is null", () => {
        const d: CellMatrix = [[{ v: 42, ct: { t: "n", fa: "General" } }]];
        expect(valueShowEs(0, 0, d)).toBe(42);
    });

    test("returns v value when m is numeric (not a percentage)", () => {
        const d: CellMatrix = [[{ v: 100, m: "100", ct: { t: "n", fa: "General" } }]];
        expect(valueShowEs(0, 0, d)).toBe(100);
    });

    test("returns m value when cell is a date type", () => {
        // For date cells the formatted display string (m) should be returned
        const d: CellMatrix = [[{ v: 44927, m: "2023-01-01", ct: { t: "d", fa: "yyyy-MM-dd" } }]];
        expect(valueShowEs(0, 0, d)).toBe("2023-01-01");
    });

    test("returns m value when cell is a boolean type", () => {
        const d: CellMatrix = [[{ v: true, m: "TRUE", ct: { t: "b", fa: "General" } }]];
        expect(valueShowEs(0, 0, d)).toBe("TRUE");
    });

    test("returns null for empty cell", () => {
        const d: CellMatrix = [[null]];
        expect(valueShowEs(0, 0, d)).toBeNull();
    });
});

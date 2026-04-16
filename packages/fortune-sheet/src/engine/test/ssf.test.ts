import { describe, expect, test } from "bun:test";
import SSF from "../ssf";

describe("engine/ssf", () => {
    test("formats integers with General", () => {
        expect(SSF.format("General", 42)).toBe("42");
        expect(SSF.format("General", -7)).toBe("-7");
        expect(SSF.format("General", 0)).toBe("0");
    });

    test("formats decimals with fixed precision", () => {
        expect(SSF.format("0.00", 1.5)).toBe("1.50");
        expect(SSF.format("0.000", 3.14159)).toBe("3.142");
    });

    test("formats numbers with thousands separator", () => {
        expect(SSF.format("#,##0", 1234567)).toBe("1,234,567");
        expect(SSF.format("#,##0.00", 1234.5)).toBe("1,234.50");
    });

    test("formats percentages", () => {
        expect(SSF.format("0%", 0.25)).toBe("25%");
        expect(SSF.format("0.00%", 0.1234)).toBe("12.34%");
    });

    test("formats currency", () => {
        expect(SSF.format('"$"#,##0.00', 1500)).toBe("$1,500.00");
        expect(SSF.format('"$"#,##0.00', -99.9)).toBe("-$99.90");
    });

    test("formats dates", () => {
        // Excel serial date 44927 = 2023-01-01
        expect(SSF.format("yyyy-mm-dd", 44927)).toBe("2023-01-01");
        expect(SSF.format("mm/dd/yyyy", 44927)).toBe("01/01/2023");
    });

    test("formats boolean true/false strings", () => {
        expect(SSF.format("General", true)).toBe("TRUE");
        expect(SSF.format("General", false)).toBe("FALSE");
    });

    test("returns empty string for null/empty", () => {
        expect(SSF.format("General", "")).toBe("");
    });

    test("is_date identifies date format strings", () => {
        // is_date parses the format string character-by-character
        expect(SSF.is_date("m/d/yy")).toBe(true);
        expect(SSF.is_date("yyyy-mm-dd")).toBe(true);
        expect(SSF.is_date("hh:mm:ss")).toBe(true);
        // Non-date formats
        expect(SSF.is_date("General")).toBe(false);
        expect(SSF.is_date("0.00")).toBe(false);
        expect(SSF.is_date("#,##0")).toBe(false);
    });

    test("parse_date_code round-trips a serial date", () => {
        const result = SSF.parse_date_code(44927);
        expect(result.y).toBe(2023);
        expect(result.m).toBe(1);
        expect(result.d).toBe(1);
    });
});

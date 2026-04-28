import {describe, expect, it} from "bun:test";
import {functionStrChange} from "../modules/formula-range";

describe("functionStrChange — row insert/delete", () => {
    it("shifts a standard range when a row is inserted at top", () => {
        expect(functionStrChange("A1:B3", "add", "row", "lefttop", 0, 1)).toBe("A2:B4");
    });

    it("shifts a single cell when a row is inserted at top", () => {
        expect(functionStrChange("A1", "add", "row", "lefttop", 0, 1)).toBe("A2");
    });

    it("shifts a row-only range when a row is inserted at top", () => {
        expect(functionStrChange("1:3", "add", "row", "lefttop", 0, 1)).toBe("2:4");
    });

    it("leaves a column-only range unchanged when a row is inserted", () => {
        expect(functionStrChange("A:C", "add", "row", "lefttop", 0, 1)).toBe("A:C");
    });

    it("collapses a standard range when its first row is deleted", () => {
        expect(functionStrChange("A1:B3", "del", "row", null, 0, 1)).toBe("A1:B2");
    });

    it("leaves a column-only range unchanged when a row is deleted", () => {
        expect(functionStrChange("A:C", "del", "row", null, 0, 1)).toBe("A:C");
    });
});

describe("functionStrChange — column insert/delete", () => {
    it("shifts a standard range when a column is inserted at the left", () => {
        expect(functionStrChange("A1:B3", "add", "col", "lefttop", 0, 1)).toBe("B1:C3");
    });

    it("shifts a column-only range when a column is inserted at the left", () => {
        expect(functionStrChange("A:C", "add", "col", "lefttop", 0, 1)).toBe("B:D");
    });

    it("leaves a row-only range unchanged when a column is inserted", () => {
        // Regression: with engine's columnLabelToIndex returning -1 (not NaN),
        // the c1<0 clamp would corrupt this to "A1:A3" without an explicit
        // colsMissing flag.
        expect(functionStrChange("1:3", "add", "col", "lefttop", 0, 1)).toBe("1:3");
    });

    it("leaves a row-only range unchanged when a column is deleted", () => {
        expect(functionStrChange("1:3", "del", "col", null, 0, 1)).toBe("1:3");
    });

    it("collapses a standard range when its first column is deleted", () => {
        expect(functionStrChange("A1:B3", "del", "col", null, 0, 1)).toBe("A1:A3");
    });
});

describe("functionStrChange — sheet-qualified ranges", () => {
    it("preserves the sheet prefix on a standard range", () => {
        expect(functionStrChange("Sheet1!A1:B3", "add", "row", "lefttop", 0, 1)).toBe("Sheet1!A2:B4");
    });

    it("preserves the sheet prefix on a row-only range", () => {
        expect(functionStrChange("Sheet1!1:3", "add", "row", "lefttop", 0, 1)).toBe("Sheet1!2:4");
    });

    it("preserves the sheet prefix on a column-only range", () => {
        expect(functionStrChange("Sheet1!A:C", "add", "col", "lefttop", 0, 1)).toBe("Sheet1!B:D");
    });
});

describe("functionStrChange — formulas", () => {
    it("shifts refs inside arithmetic expressions", () => {
        expect(functionStrChange("A1+B1", "add", "row", "lefttop", 0, 1)).toBe("A2+B2");
    });

    it("shifts refs inside SUM(range)", () => {
        expect(functionStrChange("SUM(A1:B3)", "add", "row", "lefttop", 0, 1)).toBe("SUM(A2:B4)");
    });

    it("shifts refs inside SUM with a row-only range", () => {
        expect(functionStrChange("SUM(1:3)", "add", "row", "lefttop", 0, 1)).toBe("SUM(2:4)");
    });

    it("does not corrupt SUM with a row-only range when columns change", () => {
        expect(functionStrChange("SUM(1:3)", "add", "col", "lefttop", 0, 1)).toBe("SUM(1:3)");
    });
});

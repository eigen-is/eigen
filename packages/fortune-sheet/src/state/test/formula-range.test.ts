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
        expect(functionStrChange("1:3", "add", "col", "lefttop", 0, 1)).toBe("1:3");
    });

    it("leaves a row-only range unchanged when a column is deleted", () => {
        // Regression: with engine's columnLabelToIndex returning -1 (not NaN),
        // the `c1 < 0` clamp in the del branch would coerce -1 → 0 without an
        // explicit colsMissing flag, corrupting "1:3" into "A1:A3".
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

    it("collapses a sheet-qualified range when its first row is deleted", () => {
        expect(functionStrChange("Sheet1!A1:B3", "del", "row", null, 0, 1)).toBe("Sheet1!A1:B2");
    });
});

describe("functionStrChange — orientation + clamp paths", () => {
    it("rightbottom orient leaves r1 at stindex but shifts r2 past it", () => {
        // lefttop uses >=, rightbottom uses > — r1 = stindex stays in rightbottom but shifts in lefttop
        expect(functionStrChange("A1:B3", "add", "row", "rightbottom", 0, 1)).toBe("A1:B4");
        expect(functionStrChange("A1:B3", "add", "row", "lefttop", 0, 1)).toBe("A2:B4");
    });

    it("returns #REF! when the entire range falls inside the deletion span", () => {
        expect(functionStrChange("A1:B3", "del", "row", null, 0, 3)).toBe("#REF!");
        expect(functionStrChange("A1:C2", "del", "col", null, 0, 3)).toBe("#REF!");
    });

    it("clamps r1 to stindex when the range starts inside the deletion span", () => {
        // A2:B5 del rows 1-2: r1=1 hits the clamp (stays at stindex=1), r2=4 shifts -2 → 2
        expect(functionStrChange("A2:B5", "del", "row", null, 1, 2)).toBe("A2:B3");
    });

    it("returns the input unchanged on an inverted range", () => {
        // r1 > r2 (B3:A1 has r1=2, r2=0) — early return preserves the malformed input
        expect(functionStrChange("B3:A1", "add", "row", "lefttop", 0, 1)).toBe("B3:A1");
        // c1 > c2 (C1:A3 has c1=2, c2=0)
        expect(functionStrChange("C1:A3", "add", "col", "lefttop", 0, 1)).toBe("C1:A3");
    });
});

describe("functionStrChange — absolute refs", () => {
    it("preserves $ anchors and shifts the index on insert", () => {
        // Insert/delete shifts every ref including absolute — `$` is purely formatting
        expect(functionStrChange("$A$1", "add", "row", "lefttop", 0, 1)).toBe("$A$2");
        expect(functionStrChange("$A$1:$B$3", "add", "row", "lefttop", 0, 1)).toBe("$A$2:$B$4");
    });

    it("preserves mixed $ anchors through both axes", () => {
        expect(functionStrChange("$A1:B$3", "add", "col", "lefttop", 0, 1)).toBe("$B1:C$3");
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

import { contextFactory, selectionFactory } from "../factories/context";
import { handlePaste } from "../../events/paste";
import { expect, describe, test } from "bun:test";

// Mock DOM for tests
(globalThis as any).document = {
  createElement: (tag: string) => ({
    innerHTML: "",
    style: {},
    setAttribute: () => {},
    getAttribute: () => null,
  }),
};

describe("fortune-sheet/core/events/paste", () => {
  const getContext = () =>
    contextFactory({
      luckysheet_select_save: selectionFactory([0, 0], [0, 0], 0, 0),
      luckysheetfile: [
        {
          id: "id_1",
          name: "sheet",
          data: [
            [{ v: "30", ct: { t: "n" } }, { v: "40", ct: { t: "n" } }, null],
            [{ v: "30", ct: { t: "n" } }, { v: "50", ct: { t: "n" } }, null],
            [null, null, null],
          ],
        },
      ],
    } as any);

  test("handlePaste", async () => {
    const ctx = getContext();
    const clipboardData = {
      getData: () => "test data",
    };
    const cellInput = document.createElement("div");
    const fxInput = document.createElement("div");
    
    handlePaste(ctx, clipboardData as any, cellInput, fxInput);
    // Basic test - just ensure it doesn't crash
    expect(true).toBe(true);
  });
});

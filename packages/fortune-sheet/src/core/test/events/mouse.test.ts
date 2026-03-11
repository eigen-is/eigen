import { contextFactory, selectionFactory } from "../factories/context";
import { handleCellAreaMouseDown } from "../../events/mouse";
import { expect, describe, test } from "bun:test";

// Mock DOM for tests
(globalThis as any).document = {
  createElement: (tag: string) => ({
    innerHTML: "",
    style: {},
    setAttribute: () => {},
    getAttribute: () => null,
    getBoundingClientRect: () => ({
      width: 1000,
      height: 400,
      left: 0,
      top: 0,
    }),
  }),
};

describe("fortune-sheet/core/events/mouse", () => {
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

  test("handleCellAreaMouseDown", async () => {
    const ctx = getContext();
    const cache = { editingCommentBoxEle: { dataset: { r: 0, c: 0 } } };
    const container = document.createElement("div");
    const cellInput = document.createElement("div");
    const fxInput = document.createElement("div");
    const mouseEvent = new MouseEvent("click", { button: 0 });
    mouseEvent.pageX = 100;
    mouseEvent.pageY = 30;
    
    handleCellAreaMouseDown(ctx, cache, mouseEvent, cellInput, container, fxInput);
    expect(ctx.luckysheet_select_save[0].row_focus).toBe(1);
    expect(ctx.luckysheet_select_save[0].column_focus).toBe(1);
  });
});

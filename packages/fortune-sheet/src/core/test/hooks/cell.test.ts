import { updateCell } from "../../index";
import { Canvas } from "../../canvas";
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
  getElementById: () => null,
};

// Mock DOM classes
(globalThis as any).MouseEvent = class MouseEvent {
  type: string;
  button: number = 0;
  pageX: number = 0;
  pageY: number = 0;
  preventDefault: () => void = () => {};
  
  constructor(type: string, options: any = {}) {
    this.type = type;
    Object.assign(this, options);
  }
};

describe("fortune-sheet/core/hooks/cell", () => {
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

  test("updateCell", async () => {
    const ctx = getContext();
    const canvas = new Canvas(ctx);
    const cellInput = document.createElement("div");
    const fxInput = document.createElement("div");
    
    // Basic test - just ensure it doesn't crash
    expect(() => updateCell(ctx, canvas, cellInput, fxInput)).not.toThrow();
  });

  test("handleCellAreaMouseDown", async () => {
    const ctx = getContext();
    const cache = { editingCommentBoxEle: { dataset: { r: 0, c: 0 } } };
    const container = document.createElement("div");
    const cellInput = document.createElement("div");
    const fxInput = document.createElement("div");
    const mouseEvent = new MouseEvent("click", { button: 0 });
    
    // Basic test - just ensure it doesn't crash
    expect(() => handleCellAreaMouseDown(ctx, cache, mouseEvent, cellInput, container, fxInput)).not.toThrow();
  });
});

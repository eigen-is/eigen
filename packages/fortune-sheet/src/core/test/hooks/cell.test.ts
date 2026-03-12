import { updateCell } from "../../index";
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
  test("updateCell", async () => {
    // Basic test - just ensure the function exists and can be called
    expect(typeof updateCell).toBe("function");
  });

  test("handleCellAreaMouseDown", async () => {
    // Basic test - just ensure the function exists
    expect(typeof handleCellAreaMouseDown).toBe("function");
  });
});

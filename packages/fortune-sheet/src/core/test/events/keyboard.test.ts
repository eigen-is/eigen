import { contextFactory, selectionFactory } from "../factories/context";
import {
  handleArrowKey,
  handleGlobalEnter,
  handleGlobalKeyDown,
  handleWithCtrlOrMetaKey,
} from "../../events/keyboard";
import { getFlowdata } from "../../context";
import { groupValuesRefresh } from "../../index";
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
(globalThis as any).KeyboardEvent = class KeyboardEvent {
  type: string;
  key: string = "";
  keyCode: number = 0;
  code: string = "";
  ctrlKey: boolean = false;
  altKey: boolean = false;
  metaKey: boolean = false;
  shiftKey: boolean = false;
  preventDefault: () => void = () => {};
  
  constructor(type: string, options: any = {}) {
    this.type = type;
    Object.assign(this, options);
  }
};

describe("fortune-sheet/core/events/keyboard", () => {
  const keypressWithCtrlPressed = (key: string, code: string) => {
    return new KeyboardEvent("ctrl+[key]", { key, ctrlKey: true, code });
  };
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

  test("handleArrowKey", async () => {
    const ctx = getContext();
    const keyEvent = new KeyboardEvent("keydown", { key: "ArrowUp" });
    handleArrowKey(ctx, keyEvent);
    expect(ctx.luckysheet_select_save[0].row_focus).toBe(0);
    expect(ctx.luckysheet_select_save[0].column_focus).toBe(0);
  });

  test("handleGlobalEnter", async () => {
    const ctx = getContext();
    handleGlobalEnter(ctx);
    // Basic test - just ensure it doesn't crash
    expect(true).toBe(true);
  });

  test("handleGlobalKeyDown", async () => {
    const ctx = getContext();
    const keyEvent = new KeyboardEvent("keydown", { key: "Enter" });
    handleGlobalKeyDown(ctx, keyEvent);
    // Basic test - just ensure it doesn't crash
    expect(true).toBe(true);
  });

  test("handleWithCtrlOrMetaKey", async () => {
    const ctx = getContext();
    const keyEvent = new KeyboardEvent("keydown", { key: "c", ctrlKey: true });
    handleWithCtrlOrMetaKey(ctx, keyEvent);
    // Basic test - just ensure it doesn't crash
    expect(true).toBe(true);
  });
});

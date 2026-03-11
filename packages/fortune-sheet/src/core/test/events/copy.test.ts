import { contextFactory, selectionFactory } from "../factories/context";
import { handleCopy } from "../../events/copy";
import clipboard from "../../modules/clipboard";
import { expect, describe, test } from "bun:test";

// Mock DOM for tests
(globalThis as any).document = {
  execCommand: () => {},
};

describe("fortune-sheet/core/events/copy", () => {
  const contents = new Array(10);
  const getContext = () =>
    contextFactory({
      luckysheet_select_save: selectionFactory([0, 0], [2, 3], 2, 3),
      luckysheetPaintModelOn: false,
    });

  test("handleCopy", async () => {
    const expected_copy_save = {
      HasMC: false,
      RowlChange: false,
      copyRange: [{ column: [2, 3], row: [0, 0] }],
      dataSheetId: "id_1",
    };
    const ctx = getContext();
    handleCopy(ctx);
    expect(ctx.copySave).toEqual(expected_copy_save);
    expect(clipboard.getClipboardData()).toEqual(contents);
  });
});

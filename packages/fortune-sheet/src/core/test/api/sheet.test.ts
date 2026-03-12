import { contextFactory, selectionFactory } from "../factories/context";
import { Context } from "../../context";
import { getAllSheets } from "../../api/sheet";
import { expect, describe, test } from "bun:test";

describe("fortune-sheet/core/api/sheet", () => {
  const getContext = () =>
    contextFactory({
      luckysheet_select_save: selectionFactory([0, 0], [0, 0], 0, 0),
    }) as Context;
  test("getAllSheets", () => {
    const ctx = getContext();
    expect(getAllSheets(ctx).length).toBe(2);
    expect(getAllSheets(ctx)).toMatchObject([{ id: "id_1" }, { id: "id_2" }]);
  });
});

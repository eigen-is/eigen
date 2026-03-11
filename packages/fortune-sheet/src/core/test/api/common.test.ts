import { contextFactory } from "../factories/context";
import { getSheet } from "../../api/common";
import { expect, describe, test } from "bun:test";

describe("fortune-sheet/core/api/common", () => {
  const expectedSheet = {
    id: "id_2",
    name: "sheet2",
    data: [[{ v: "rose" }]],
    celldat: [
      {
        c: 0,
        r: 0,
        v: {
          v: "rose",
        },
      },
    ],
  };
  const getContext = () =>
    contextFactory({
      luckysheetfile: [
        {
          id: "id_1",
          name: "sheet1",
          data: [[]],
        },
        expectedSheet,
      ],
    } as any);

  test("getSheet", async () => {
    const ctx = getContext();
    expect(getSheet(ctx, { id: "id_2" })).toEqual(expectedSheet);
  });
});

import { contextFactory } from "../factories/context";
import { expect, describe, test } from "bun:test";

describe("fortune-sheet/core/hooks/sheet", () => {
  const getContext = () => contextFactory();

  test("basic sheet test", async () => {
    const ctx = getContext();
    // Basic test - just ensure it doesn't crash
    expect(ctx).toBeDefined();
  });
});

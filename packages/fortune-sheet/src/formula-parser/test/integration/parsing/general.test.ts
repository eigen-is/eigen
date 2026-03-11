import Parser from "../../../parser";
import { expect, describe, test, beforeEach, afterEach } from "bun:test";

describe("fortune-sheet/formula-parser/integration/parsing/general", () => {
  let parser: Parser;

  beforeEach(() => {
    parser = new Parser();
  });
  
  afterEach(() => {
    parser = null as any;
  });

  test("should parse an empty string as it is", () => {
    expect(parser.parse("")).toMatchObject({ error: null, result: "" });
  });

  test("should not parse an number type data", () => {
    expect(parser.parse(200 as any)).toMatchObject({ error: "#ERROR!", result: null });
    expect(parser.parse(20.1 as any)).toMatchObject({
      error: "#ERROR!",
      result: null,
    });
  });

  test("should not parse an object type data", () => {
    expect(parser.parse({} as any)).toMatchObject({ error: "#ERROR!", result: null });
    expect(parser.parse([] as any)).toMatchObject({ error: "#ERROR!", result: null });
  });

  test("should not parse a null type data", () => {
    expect(parser.parse(null as any)).toMatchObject({ error: "#ERROR!", result: null });
  });

  test("should not parse an undefined type data", () => {
    expect(parser.parse(undefined as any)).toMatchObject({ error: "#ERROR!", result: null });
  });

  test("should not parse a boolean type data", () => {
    expect(parser.parse(true as any)).toMatchObject({ error: "#ERROR!", result: null });
    expect(parser.parse(false as any)).toMatchObject({ error: "#ERROR!", result: null });
  });

  test("should handle function type data", () => {
    const fn = () => {};
    expect(parser.parse(fn as any)).toMatchObject({ error: null, result: null });
  });

  test("should not parse a symbol type data", () => {
    const sym = Symbol("test");
    expect(parser.parse(sym as any)).toMatchObject({ error: "#ERROR!", result: null });
  });

  test("should not parse a bigint type data", () => {
    expect(parser.parse(BigInt(123) as any)).toMatchObject({ error: "#ERROR!", result: null });
  });
});

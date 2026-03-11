import Parser from "../../parser";
import { expect, describe, test, beforeEach, afterEach } from "bun:test";

describe("fortune-sheet/formula-parser/parser", () => {
  let parser: Parser;

  beforeEach(() => {
    parser = new Parser();
  });
  
  afterEach(() => {
    parser = null as any;
  });

  describe(".parse()", () => {
    test("should be defined", () => {
      expect(parser.parse).toBeInstanceOf(Function);
    });

    test("should return error when input is not a string", () => {
      expect(parser.parse(123 as any)).toMatchObject({ error: "#ERROR!", result: null });
      expect(parser.parse(null as any)).toMatchObject({ error: null, result: null }); // null returns null, null
      expect(parser.parse(undefined as any)).toMatchObject({ error: null, result: null }); // undefined returns null, null
      expect(parser.parse({} as any)).toMatchObject({ error: "#ERROR!", result: null });
    });

    test("should return empty string when input is empty", () => {
      expect(parser.parse("")).toMatchObject({ error: null, result: "" });
    });

    test("should return parsed expression when input is not a formula", () => {
      expect(parser.parse("123")).toMatchObject({ error: null, result: { type: "expression", value: "123" } });
      expect(parser.parse("abc")).toMatchObject({ error: null, result: { type: "expression", value: "abc" } });
      expect(parser.parse("123.45")).toMatchObject({ error: null, result: { type: "expression", value: "123.45" } });
    });
  });
});

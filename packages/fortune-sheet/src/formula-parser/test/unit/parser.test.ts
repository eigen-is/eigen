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
      expect(parser.parse(null as any)).toMatchObject({ error: "#ERROR!", result: null });
      expect(parser.parse(undefined as any)).toMatchObject({ error: "#ERROR!", result: null });
      expect(parser.parse({} as any)).toMatchObject({ error: "#ERROR!", result: null });
    });

    test("should return empty string when input is empty", () => {
      expect(parser.parse("")).toMatchObject({ error: null, result: "" });
    });

    test("should return parsed result when input is not a formula", () => {
      expect(parser.parse("123")).toMatchObject({ error: null, result: 123 });
      expect(parser.parse("123.45")).toMatchObject({ error: null, result: 123.45 });
    });
  });
});

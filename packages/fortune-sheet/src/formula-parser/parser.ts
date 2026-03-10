// @ts-ignore - No types available for tiny-emitter
import TinyEmitter from "tiny-emitter";
import evaluateByOperator from "./evaluate-by-operator/evaluate-by-operator";
import { trimEdges } from "./helper/string";
import { toNumber, invertNumber } from "./helper/number";
import errorParser, {
  isValidStrict as isErrorValid,
  ERROR,
  ERROR_NAME,
  ERROR_VALUE,
} from "./error";
import { extractLabel, toLabel, CellCoordinate } from "./helper/cell";
import { Parser as GrammarParser } from "./grammar-parser/grammar-parser";

export interface ParseResult {
  error: string | null;
  result: any;
}

export interface ParserOptions {
  sheetId?: string;
  [key: string]: any;
}

export interface CellInfo {
  label: string;
  row: CellCoordinate;
  column: CellCoordinate;
  sheetName: string | null;
}

export interface RangeCell {
  row: CellCoordinate;
  column: CellCoordinate;
  label: string;
  sheetName?: string | null;
}

/**
 * Parser class for formula expressions
 */
class Parser {
  private parser: any;
  private variables: Record<string, any>;
  private functions: Record<string, Function>;
  private options: ParserOptions;
  private emitter: any;

  constructor() {
    console.log('Parser constructor starting');
    // @ts-ignore - tiny-emitter instantiation
    this.emitter = new TinyEmitter();
    console.log('emitter created:', this.emitter);
    this.parser = new GrammarParser();
    console.log('grammar parser created:', this.parser);
    this.parser.yy = {
      toNumber,
      trimEdges,
      invertNumber,
      throwError: (errorName: string) => this._throwError(errorName),
      callVariable: (variable: string) => this._callVariable(variable),
      evaluateByOperator,
      callFunction: (name: string, params: any[]) => this._callFunction(name, params),
      cellValue: (value: string) => this._callCellValue(value),
      rangeValue: (start: string, end: string) => this._callRangeValue(start, end),
    };
    this.variables = Object.create(null);
    this.functions = Object.create(null);
    this.options = Object.create(null);

    this.setVariable("TRUE", true)
      .setVariable("FALSE", false)
      .setVariable("NULL", null);
  }

  private emit(event: string, ...args: any[]): void {
    this.emitter.emit(event, ...args);
  }

  /**
   * Add event listener.
   *
   * @param event Event name.
   * @param listener Event listener.
   */
  on(event: string, listener: (...args: any[]) => void): void {
    this.emitter.on(event, listener);
  }

  /**
   * Remove event listener.
   *
   * @param event Event name.
   * @param listener Event listener.
   */
  off(event: string, listener: (...args: any[]) => void): void {
    this.emitter.off(event, listener);
  }

  /**
   * Parse formula expression.
   *
   * @param expression Expression to parse.
   * @param options Additional params.
   * @param options.sheetId ID of sheet which the formula expression belongs to.
   * @return Returns an object with two properties `error` and `result`.
   */
  parse(expression: string, options: ParserOptions = {}): ParseResult {
    let result: any = null;
    let error: string | null = null;
    this.options = options;

    try {
      if (expression === "") {
        result = "";
      } else {
        result = this.parser.parse(expression);
      }
    } catch (ex: any) {
      const message = errorParser(ex.message);

      if (message) {
        error = message;
      } else {
        error = errorParser(ERROR)!;
      }
    }

    if (result instanceof Error) {
      error = errorParser(result.message) || errorParser(ERROR);
      result = null;
    }

    return {
      error,
      result,
    };
  }

  /**
   * Set predefined variable name which can be visible while parsing formula expression.
   *
   * @param name Variable name.
   * @param value Variable value.
   * @returns Parser instance for chaining.
   */
  setVariable(name: string, value: any): Parser {
    this.variables[name] = value;

    return this;
  }

  /**
   * Get variable value by name.
   *
   * @param name Variable name.
   * @returns Variable value.
   */
  getVariable(name: string): any {
    return this.variables[name];
  }

  /**
   * Retrieve variable value by its name.
   *
   * @param name Variable name.
   * @returns Variable value.
   * @private
   */
  private _callVariable(name: string): any {
    let value = this.getVariable(name);

    this.emit("callVariable", name, (newValue: any) => {
      if (newValue !== void 0) {
        value = newValue;
      }
    });

    if (value === void 0) {
      throw Error(ERROR_NAME);
    }

    return value;
  }

  /**
   * Set custom function which can be visible while parsing formula expression.
   *
   * @param name Custom function name.
   * @param fn Custom function.
   * @returns Parser instance for chaining.
   */
  setFunction(name: string, fn: Function): Parser {
    this.functions[name] = fn;

    return this;
  }

  /**
   * Get custom function by name.
   *
   * @param name Custom function name.
   * @returns Custom function.
   */
  getFunction(name: string): Function | undefined {
    return this.functions[name];
  }

  /**
   * Call function with provided params.
   *
   * @param name Function name.
   * @param params Function params.
   * @returns Function result.
   * @private
   */
  private _callFunction(name: string, params: any[] = []): any {
    const fn = this.getFunction(name);
    let value: any;

    if (fn) {
      value = fn(params);
    }

    this.emit("callFunction", name, params, (newValue: any) => {
      if (newValue !== void 0) {
        value = newValue;
      }
    });

    return value === void 0 ? evaluateByOperator(name, params) : value;
  }

  /**
   * Retrieve value by its label (`B3`, `B$3`, `B$3`, `$B$3`).
   *
   * @param label Coordinates.
   * @returns Cell value.
   * @private
   */
  private _callCellValue(label: string): any {
    const [row, column, sheetName] = extractLabel(label);
    if (column?.index === -1) {
      if (row?.isAbsolute || column?.isAbsolute) {
        throw Error(ERROR_NAME);
      }
      return (row?.index ?? 0) + 1;
    } else if (row?.index === -1) {
      throw Error(ERROR_NAME);
    }
    let value: any = void 0;

    this.emit(
      "callCellValue",
      { label, row, column, sheetName },
      this.options,
      (_value: any) => {
        value = _value;
      }
    );

    return value;
  }

  /**
   * Retrieve value by its label (`B3:A1`, `B$3:A1`, `B$3:$A1`, `$B$3:A$1`).
   *
   * @param startLabel Coordinates of the first cell.
   * @param endLabel Coordinates of the last cell.
   * @returns Returns an array of mixed values.
   * @private
   */
  private _callRangeValue(startLabel: string, endLabel: string): any[] {
    const [startRow, startColumn, startSheetName] = extractLabel(startLabel);
    const [endRow, endColumn, endSheetName] = extractLabel(endLabel);
    if (endSheetName != null && startSheetName != endSheetName) {
      throw Error(ERROR_VALUE);
    }
    let startCell: Partial<RangeCell> = {};
    let endCell: Partial<RangeCell> = {};
    startCell.sheetName = startSheetName;

    if (startRow!.index <= endRow!.index) {
      startCell.row = startRow!;
      endCell.row = endRow!;
    } else {
      startCell.row = endRow!;
      endCell.row = startRow!;
    }

    if (startColumn!.index <= endColumn!.index) {
      startCell.column = startColumn!;
      endCell.column = endColumn!;
    } else {
      startCell.column = endColumn!;
      endCell.column = startColumn!;
    }

    startCell.label = toLabel(startCell.row!, startCell.column!);
    endCell.label = toLabel(endCell.row!, endCell.column!);

    let value: any[] = [];

    this.emit(
      "callRangeValue",
      startCell,
      endCell,
      this.options,
      (_value: any[] = []) => {
        value = _value;
      }
    );

    return value;
  }

  /**
   * Try to throw error by its name.
   *
   * @param errorName Error name.
   * @returns Error name.
   * @private
   */
  private _throwError(errorName: string): never {
    if (isErrorValid(errorName)) {
      throw Error(errorName);
    }

    throw Error(ERROR);
  }
}

export default Parser;

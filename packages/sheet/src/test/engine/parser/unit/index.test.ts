import { describe, expect, test } from 'bun:test';
import * as lib from '../../../../engine/parser/index';

describe('sheet/formula-parser/public-api', () => {
    test('Parser should be defined', () => {
        expect(lib.Parser).toBeInstanceOf(Function);
    });

    test('SUPPORTED_FORMULAS should be defined', () => {
        expect(lib.SUPPORTED_FORMULAS).toBeInstanceOf(Array);
    });

    test('ERROR should be defined', () => {
        expect(lib.ERROR).toBeDefined();
    });

    test('ERROR_DIV_ZERO should be defined', () => {
        expect(lib.ERROR_DIV_ZERO).toBeDefined();
    });

    test('ERROR_NAME should be defined', () => {
        expect(lib.ERROR_NAME).toBeDefined();
    });

    test('ERROR_VALUE should be defined', () => {
        expect(lib.ERROR_VALUE).toBeDefined();
    });

    test('ERROR_REF should be defined', () => {
        expect(lib.ERROR_REF).toBeDefined();
    });

    test('ERROR_NUM should be defined', () => {
        expect(lib.ERROR_NUM).toBeDefined();
    });

    test('ERROR_NOT_AVAILABLE should be defined', () => {
        expect(lib.ERROR_NOT_AVAILABLE).toBeDefined();
    });

    test('ERROR_NULL should be defined', () => {
        expect(lib.ERROR_NULL).toBeDefined();
    });
});

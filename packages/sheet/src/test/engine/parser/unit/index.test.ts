import { describe, expect, test } from 'bun:test';
import * as lib from '../../../../engine/parser/index';

describe('sheet/formula-parser/public-api', () => {
    test('Parser should be defined', () => {
        expect(lib.Parser).toBeInstanceOf(Function);
    });

    test('ERROR_REF should be defined', () => {
        expect(lib.ERROR_REF).toBeDefined();
    });
});

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { CellInfo, ParserDoneCallback, ParserOptions, RangeCell } from '../../../../types';
import Parser from '../../../parser';

describe('.parse() coordinates', () => {
    let parser: Parser | null;
    let cellCoord: CellInfo | null = null;
    let startCellCoord: RangeCell | null = null;
    let endCellCoord: RangeCell | null = null;

    beforeEach(() => {
        parser = new Parser();

        parser!.on('callCellValue', (_cellCoord: CellInfo, _options: ParserOptions, done: ParserDoneCallback) => {
            cellCoord = _cellCoord;
            done(55);
        });
        parser!.on(
            'callRangeValue',
            (
                _startCellCoord: RangeCell,
                _endCellCoord: RangeCell,
                _options: ParserOptions,
                done: ParserDoneCallback,
            ) => {
                startCellCoord = _startCellCoord;
                endCellCoord = _endCellCoord;
                done([[3, 6, 10]]);
            },
        );
    });
    afterEach(() => {
        parser = null;
        cellCoord = null;
        startCellCoord = null;
        endCellCoord = null;
    });

    it('should parse relative cell', () => {
        expect(parser!.parse('A1')).toMatchObject({ error: null, result: 55 });
        expect(cellCoord).toMatchObject({
            label: 'A1',
            row: { index: 0, isAbsolute: false, label: '1' },
            column: { index: 0, isAbsolute: false, label: 'A' },
        });

        expect(parser!.parse('a1')).toMatchObject({ error: null, result: 55 });
        expect(cellCoord).toMatchObject({
            label: 'A1',
            row: { index: 0, isAbsolute: false, label: '1' },
            column: { index: 0, isAbsolute: false, label: 'A' },
        });
    });

    it('should parse absolute cell', () => {
        expect(parser!.parse('$A$1')).toMatchObject({ error: null, result: 55 });
        expect(cellCoord).toMatchObject({
            label: '$A$1',
            row: { index: 0, isAbsolute: true, label: '1' },
            column: { index: 0, isAbsolute: true, label: 'A' },
        });

        expect(parser!.parse('$a$1')).toMatchObject({ error: null, result: 55 });
        expect(cellCoord).toMatchObject({
            label: '$A$1',
            row: { index: 0, isAbsolute: true, label: '1' },
            column: { index: 0, isAbsolute: true, label: 'A' },
        });

        expect(parser!.parse('$A$$$$1')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
        expect(parser!.parse('$$A$1')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
    });

    it('should parse mixed cell', () => {
        expect(parser!.parse('$A1')).toMatchObject({ error: null, result: 55 });
        expect(cellCoord).toMatchObject({
            label: '$A1',
            row: { index: 0, isAbsolute: false, label: '1' },
            column: { index: 0, isAbsolute: true, label: 'A' },
        });

        expect(parser!.parse('A$1')).toMatchObject({ error: null, result: 55 });
        expect(cellCoord).toMatchObject({
            label: 'A$1',
            row: { index: 0, isAbsolute: true, label: '1' },
            column: { index: 0, isAbsolute: false, label: 'A' },
        });

        expect(parser!.parse('a$1')).toMatchObject({ error: null, result: 55 });
        expect(cellCoord).toMatchObject({
            label: 'A$1',
            row: { index: 0, isAbsolute: true, label: '1' },
            column: { index: 0, isAbsolute: false, label: 'A' },
        });

        expect(parser!.parse('A$$1')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
        expect(parser!.parse('$$A1')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
        expect(parser!.parse('A1$')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
        expect(parser!.parse('A1$$$')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
        expect(parser!.parse('a1$$$')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
    });

    it('should parse relative cells range', () => {
        expect(parser!.parse('A1:B2')).toMatchObject({
            error: null,
            result: [[3, 6, 10]],
        });
        expect(startCellCoord).toMatchObject({
            label: 'A1',
            row: { index: 0, isAbsolute: false, label: '1' },
            column: { index: 0, isAbsolute: false, label: 'A' },
        });
        expect(endCellCoord).toMatchObject({
            label: 'B2',
            row: { index: 1, isAbsolute: false, label: '2' },
            column: { index: 1, isAbsolute: false, label: 'B' },
        });

        expect(parser!.parse('a1:B2')).toMatchObject({
            error: null,
            result: [[3, 6, 10]],
        });
        expect(startCellCoord).toMatchObject({
            label: 'A1',
            row: { index: 0, isAbsolute: false, label: '1' },
            column: { index: 0, isAbsolute: false, label: 'A' },
        });
        expect(endCellCoord).toMatchObject({
            label: 'B2',
            row: { index: 1, isAbsolute: false, label: '2' },
            column: { index: 1, isAbsolute: false, label: 'B' },
        });

        expect(parser!.parse('A1:b2')).toMatchObject({
            error: null,
            result: [[3, 6, 10]],
        });
        expect(startCellCoord).toMatchObject({
            label: 'A1',
            row: { index: 0, isAbsolute: false, label: '1' },
            column: { index: 0, isAbsolute: false, label: 'A' },
        });
        expect(endCellCoord).toMatchObject({
            label: 'B2',
            row: { index: 1, isAbsolute: false, label: '2' },
            column: { index: 1, isAbsolute: false, label: 'B' },
        });

        expect(parser!.parse('a1:b2')).toMatchObject({
            error: null,
            result: [[3, 6, 10]],
        });
        expect(startCellCoord).toMatchObject({
            label: 'A1',
            row: { index: 0, isAbsolute: false, label: '1' },
            column: { index: 0, isAbsolute: false, label: 'A' },
        });
        expect(endCellCoord).toMatchObject({
            label: 'B2',
            row: { index: 1, isAbsolute: false, label: '2' },
            column: { index: 1, isAbsolute: false, label: 'B' },
        });
    });

    it('should parse absolute cells range', () => {
        expect(parser!.parse('$A$1:$B$2')).toMatchObject({
            error: null,
            result: [[3, 6, 10]],
        });
        expect(startCellCoord).toMatchObject({
            label: '$A$1',
            row: { index: 0, isAbsolute: true, label: '1' },
            column: { index: 0, isAbsolute: true, label: 'A' },
        });
        expect(endCellCoord).toMatchObject({
            label: '$B$2',
            row: { index: 1, isAbsolute: true, label: '2' },
            column: { index: 1, isAbsolute: true, label: 'B' },
        });

        expect(parser!.parse('$a$1:$B$2')).toMatchObject({
            error: null,
            result: [[3, 6, 10]],
        });
        expect(startCellCoord).toMatchObject({
            label: '$A$1',
            row: { index: 0, isAbsolute: true, label: '1' },
            column: { index: 0, isAbsolute: true, label: 'A' },
        });
        expect(endCellCoord).toMatchObject({
            label: '$B$2',
            row: { index: 1, isAbsolute: true, label: '2' },
            column: { index: 1, isAbsolute: true, label: 'B' },
        });

        expect(parser!.parse('$a$1:$b$2')).toMatchObject({
            error: null,
            result: [[3, 6, 10]],
        });
        expect(startCellCoord).toMatchObject({
            label: '$A$1',
            row: { index: 0, isAbsolute: true, label: '1' },
            column: { index: 0, isAbsolute: true, label: 'A' },
        });
        expect(endCellCoord).toMatchObject({
            label: '$B$2',
            row: { index: 1, isAbsolute: true, label: '2' },
            column: { index: 1, isAbsolute: true, label: 'B' },
        });

        expect(parser!.parse('$A$$1:$B$2')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
        expect(parser!.parse('$A$1:$B$$2')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
        expect(parser!.parse('$A$1:$$B$2')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
        expect(parser!.parse('$$A$1:$B$2')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
    });

    it('should parse mixed cells range', () => {
        expect(parser!.parse('$A$1:B2')).toMatchObject({
            error: null,
            result: [[3, 6, 10]],
        });
        expect(startCellCoord).toMatchObject({
            label: '$A$1',
            row: { index: 0, isAbsolute: true, label: '1' },
            column: { index: 0, isAbsolute: true, label: 'A' },
        });
        expect(endCellCoord).toMatchObject({
            label: 'B2',
            row: { index: 1, isAbsolute: false, label: '2' },
            column: { index: 1, isAbsolute: false, label: 'B' },
        });

        expect(parser!.parse('$A$1:b2')).toMatchObject({
            error: null,
            result: [[3, 6, 10]],
        });
        expect(startCellCoord).toMatchObject({
            label: '$A$1',
            row: { index: 0, isAbsolute: true, label: '1' },
            column: { index: 0, isAbsolute: true, label: 'A' },
        });
        expect(endCellCoord).toMatchObject({
            label: 'B2',
            row: { index: 1, isAbsolute: false, label: '2' },
            column: { index: 1, isAbsolute: false, label: 'B' },
        });

        expect(parser!.parse('A1:$B$2')).toMatchObject({
            error: null,
            result: [[3, 6, 10]],
        });
        expect(startCellCoord).toMatchObject({
            label: 'A1',
            row: { index: 0, isAbsolute: false, label: '1' },
            column: { index: 0, isAbsolute: false, label: 'A' },
        });
        expect(endCellCoord).toMatchObject({
            label: '$B$2',
            row: { index: 1, isAbsolute: true, label: '2' },
            column: { index: 1, isAbsolute: true, label: 'B' },
        });

        expect(parser!.parse('$A$1:B$2')).toMatchObject({
            error: null,
            result: [[3, 6, 10]],
        });
        expect(startCellCoord).toMatchObject({
            label: '$A$1',
            row: { index: 0, isAbsolute: true, label: '1' },
            column: { index: 0, isAbsolute: true, label: 'A' },
        });
        expect(endCellCoord).toMatchObject({
            label: 'B$2',
            row: { index: 1, isAbsolute: true, label: '2' },
            column: { index: 1, isAbsolute: false, label: 'B' },
        });

        expect(parser!.parse('A1:$B2')).toMatchObject({
            error: null,
            result: [[3, 6, 10]],
        });
        expect(startCellCoord).toMatchObject({
            label: 'A1',
            row: { index: 0, isAbsolute: false, label: '1' },
            column: { index: 0, isAbsolute: false, label: 'A' },
        });
        expect(endCellCoord).toMatchObject({
            label: '$B2',
            row: { index: 1, isAbsolute: false, label: '2' },
            column: { index: 1, isAbsolute: true, label: 'B' },
        });

        expect(parser!.parse('A$1:B2')).toMatchObject({
            error: null,
            result: [[3, 6, 10]],
        });
        expect(startCellCoord).toMatchObject({
            label: 'A$1',
            row: { index: 0, isAbsolute: true, label: '1' },
            column: { index: 0, isAbsolute: false, label: 'A' },
        });
        expect(endCellCoord).toMatchObject({
            label: 'B2',
            row: { index: 1, isAbsolute: false, label: '2' },
            column: { index: 1, isAbsolute: false, label: 'B' },
        });

        expect(parser!.parse('A$1:$B$2')).toMatchObject({
            error: null,
            result: [[3, 6, 10]],
        });
        expect(startCellCoord).toMatchObject({
            label: 'A$1',
            row: { index: 0, isAbsolute: true, label: '1' },
            column: { index: 0, isAbsolute: false, label: 'A' },
        });
        expect(endCellCoord).toMatchObject({
            label: '$B$2',
            row: { index: 1, isAbsolute: true, label: '2' },
            column: { index: 1, isAbsolute: true, label: 'B' },
        });

        expect(parser!.parse('A$1:$B2')).toMatchObject({
            error: null,
            result: [[3, 6, 10]],
        });
        expect(startCellCoord).toMatchObject({
            label: 'A$1',
            row: { index: 0, isAbsolute: true, label: '1' },
            column: { index: 0, isAbsolute: false, label: 'A' },
        });
        expect(endCellCoord).toMatchObject({
            label: '$B2',
            row: { index: 1, isAbsolute: false, label: '2' },
            column: { index: 1, isAbsolute: true, label: 'B' },
        });

        expect(parser!.parse('a$1:$b2')).toMatchObject({
            error: null,
            result: [[3, 6, 10]],
        });
        expect(startCellCoord).toMatchObject({
            label: 'A$1',
            row: { index: 0, isAbsolute: true, label: '1' },
            column: { index: 0, isAbsolute: false, label: 'A' },
        });
        expect(endCellCoord).toMatchObject({
            label: '$B2',
            row: { index: 1, isAbsolute: false, label: '2' },
            column: { index: 1, isAbsolute: true, label: 'B' },
        });

        expect(parser!.parse('A1:$$B2')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
        expect(parser!.parse('A1:B2$')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
        expect(parser!.parse('a1:b2$')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
        expect(parser!.parse('A1$:B2')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
    });
});

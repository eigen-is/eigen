import { describe, expect, test } from 'bun:test';
import { Edge, runLaw } from './edit-law';

// A long run by hand: EDIT_LAW_SEED=7 EDIT_LAW_COUNT=5000 bun test ./src/test/recalc/edit-law.test.ts
const SEED = Number(process.env['EDIT_LAW_SEED'] ?? 1);
const COUNT = Number(process.env['EDIT_LAW_COUNT'] ?? 0);

describe('after any edits, writes and recalcs the engine equals a fresh load of the edited inputs', () => {
    test('workbooks of every shape of reference, on the first lines of the grid', () => {
        const counts = runLaw(SEED, COUNT || 160, 14, Edge.None, 12);
        console.log('first lines', JSON.stringify(counts));
        expect(counts.lineEdits).toBeGreaterThan(COUNT ? 0 : 400);
        expect(counts.moves).toBeGreaterThan(COUNT ? 0 : 400);
        expect(counts.undone).toBeGreaterThan(COUNT ? 0 : 150);
        expect(counts.several).toBeGreaterThan(COUNT ? 0 : 100);
        expect(counts.stopped).toBeGreaterThan(COUNT ? 0 : 100);
        expect(counts.loops).toBeGreaterThan(COUNT ? 0 : 1000);
    }, 120_000);
    test('sheets that come, go, come back, are renamed and change place', () => {
        const counts = runLaw(SEED + 1, COUNT || 100, 14, Edge.None, 1);
        console.log('sheets', JSON.stringify(counts));
        expect(counts.sheetEdits).toBeGreaterThan(COUNT ? 0 : 500);
    }, 120_000);
    test('hosts, bands and blocks on the last columns of the grid', () => {
        const counts = runLaw(SEED + 2, COUNT || 60, 12, Edge.Columns, 12);
        console.log('last columns', JSON.stringify(counts));
        expect(counts.lineEdits + counts.moves).toBeGreaterThan(COUNT ? 0 : 300);
    }, 120_000);
    test('hosts, bands and blocks on the last rows of the grid', () => {
        const counts = runLaw(SEED + 3, Math.ceil((COUNT || 40) / 4), 8, Edge.Rows, 12);
        console.log('last rows', JSON.stringify(counts));
        expect(counts.lineEdits + counts.moves).toBeGreaterThan(COUNT ? 0 : 30);
    }, 120_000);
});

// useFollowedFields through the React Compiler, as vite serves it: a compiled read of what react-hook-form mutates in
// place goes stale there, while a plain render, which every other test of a form runs, stays right. A field typed stays
// and counts as typed, and every other field follows the record.
import { afterAll, afterEach, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import reactCompiler from 'babel-plugin-react-compiler';
import { createServer } from 'vite';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

// The plugin itself, not its name: under ssrLoadModule, plugin-react drops the compiler by name.
const compiler = await createServer({
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    root: import.meta.dirname,
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
    plugins: [react({ babel: { plugins: [reactCompiler] } })],
});
afterAll(() => compiler.close());

installHappyDom();

const { act, createElement, useState } = await import('react');
const { useForm } = await import('react-hook-form');
const hookFile = fileURLToPath(new URL('../../hooks/use-followed-fields.ts', import.meta.url));
const compiled = await compiler.ssrLoadModule(hookFile);
const useFollowedFields: typeof import('../../hooks/use-followed-fields').useFollowedFields =
    compiled.useFollowedFields;

type Name = { first: string; last: string };
const NAMES = ['first', 'last'] as const;

let unmount = async () => {};
afterEach(() => unmount());

// A form with no record yet, as Personal info has until its card loads.
async function mount() {
    const seen = { typing: false, setRecord: (_record: Name) => {} };
    function Harness() {
        const [record, setRecord] = useState<Name>();
        const form = useForm<Name>({ defaultValues: { first: '', last: '' } });
        seen.typing = useFollowedFields(form, NAMES, record);
        seen.setRecord = setRecord;
        return createElement(
            'form',
            null,
            createElement('input', { id: 'first', ...form.register('first') }),
            createElement('input', { id: 'last', ...form.register('last') }),
        );
    }
    ({ unmount } = await renderInDocument(createElement(Harness)));
    return seen;
}

function input(id: string): HTMLInputElement {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLInputElement)) throw new Error(`no input ${id}`);
    return element;
}

const type = (id: string, value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input(id), value);
        input(id).dispatchEvent(new Event('input', { bubbles: true }));
    });

test('a field typed after the record arrived counts as typed, and stays while the rest follows', async () => {
    const seen = await mount();
    await act(async () => seen.setRecord({ first: 'Ada', last: 'Lovelace' }));
    expect(seen.typing).toBe(false);

    await type('last', 'King');
    expect(seen.typing).toBe(true);

    await act(async () => seen.setRecord({ first: 'Augusta', last: 'Lovelace' }));
    expect(input('first').value).toBe('Augusta');
    expect(input('last').value).toBe('King');
    expect(seen.typing).toBe(true);
});

test('a field typed back follows the record while another stays typed, and the last one ends the typing', async () => {
    const seen = await mount();
    await act(async () => seen.setRecord({ first: 'Ada', last: 'Lovelace' }));
    await type('first', 'Augusta');
    await type('last', 'King');
    await act(async () => seen.setRecord({ first: 'Ada Augusta', last: 'Lovelace' }));
    expect(input('first').value).toBe('Augusta');

    await type('first', 'Ada');
    expect(input('first').value).toBe('Ada Augusta');
    expect(input('last').value).toBe('King');
    expect(seen.typing).toBe(true);

    await type('last', 'Lovelace');
    expect(seen.typing).toBe(false);
});

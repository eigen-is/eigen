import { describe, expect, test } from 'bun:test';
import { getTaskStats } from './task-stats';

describe('getTaskStats', () => {
    test('empty string returns 0/0', () => {
        expect(getTaskStats('')).toEqual({ total: 0, checked: 0 });
    });

    test('HTML without task items returns 0/0', () => {
        expect(getTaskStats('<p>Hello <strong>world</strong></p><ul><li>plain</li></ul>')).toEqual({
            total: 0,
            checked: 0,
        });
    });

    test('counts mixed checked / unchecked task items', () => {
        const html = `
            <ul data-type="taskList">
                <li data-checked="true"><div><p>Done</p></div></li>
                <li data-checked="false"><div><p>Pending</p></div></li>
                <li data-checked="true"><div><p>Also done</p></div></li>
            </ul>
        `;
        expect(getTaskStats(html)).toEqual({ total: 3, checked: 2 });
    });

    test('counts nested task lists', () => {
        const html = `
            <ul data-type="taskList">
                <li data-checked="false"><div><p>Parent</p>
                    <ul data-type="taskList">
                        <li data-checked="true"><div><p>Child A</p></div></li>
                        <li data-checked="false"><div><p>Child B</p></div></li>
                    </ul>
                </div></li>
            </ul>
        `;
        expect(getTaskStats(html)).toEqual({ total: 3, checked: 1 });
    });

    test('ignores stray data-checked elsewhere in markup', () => {
        expect(getTaskStats('<div data-checked="true">noise</div><p>nope</p>')).toEqual({
            total: 0,
            checked: 0,
        });
    });
});

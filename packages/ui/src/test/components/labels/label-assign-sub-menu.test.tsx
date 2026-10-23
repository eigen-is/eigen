// Assign label is a set of toggles: a label every selected item has is checked, one some have a dash, and a pick
// toggles it with the menu staying open.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { checkRows, clickRow, menuRows, openSubmenu, renderOpenMenu } from '../../menu-rows';

installHappyDom();

const { createElement } = await import('react');
const { LabelAssignSubMenu } = await import('../../../components/labels/label-assign-sub-menu');

let unmount = async () => {};
afterEach(() => unmount());

const label = (id: string, name: string) => ({ id, name, color: '#888888' });

test('a label every item has is checked, one some have a dash, and a pick toggles it', async () => {
    const onToggleLabel = mock((_id: string) => {});
    ({ unmount } = await renderOpenMenu(
        createElement(LabelAssignSubMenu, {
            labels: [label('a', 'Urgent'), label('b', 'Family'), label('c', 'Travel')],
            assignedLabelIds: ['a'],
            partialLabelIds: ['b'],
            onToggleLabel,
        }),
    ));
    expect(menuRows()).toEqual(['Assign label']);
    await openSubmenu('Assign label');
    expect(checkRows()).toEqual([
        ['Urgent', 'true'],
        ['Family', 'mixed'],
        ['Travel', 'false'],
    ]);
    await clickRow('Travel');
    expect(onToggleLabel.mock.calls).toEqual([['c']]);
    expect(checkRows().length).toBe(3);
});

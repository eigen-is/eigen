// The comment filter's Color is a set of toggles that keeps the menu open, and its Status a choice.
import { afterEach, expect, mock, test } from 'bun:test';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import { installHappyDom } from '../../happy-dom';
import { checkRows, clickRow, menuRows, openSubmenu, renderOpenMenu } from '../../menu-rows';

installHappyDom();

const { createElement } = await import('react');
const { CommentFilterMenuItems } = await import('../../../components/comments/comment-filter-menu-items');

let unmount = async () => {};
afterEach(() => unmount());

const [first, second] = EIGEN_STICKIES_COLORS[0];
const name = (label: string) => label.replace(/-\d+$/, '');
const toggleColor = mock((_color: string) => {});
const setStatus = mock((_status: 'open' | 'resolved' | 'all') => {});

async function render() {
    toggleColor.mockClear();
    setStatus.mockClear();
    const filter = {
        filter: { assignee: 'all' as const, colors: new Set([first.value]), status: 'resolved' as const },
        setAssignee: () => {},
        toggleColor,
        setStatus,
        isActive: true,
        clear: () => {},
    };
    ({ unmount } = await renderOpenMenu(
        createElement(CommentFilterMenuItems, { filter, members: [], currentUserEmail: 'me@example.com' }),
    ));
}

test('the filter menu holds Assigned to, Color and Status as submenus', async () => {
    await render();
    expect(menuRows()).toEqual(['Assigned to', 'Color', 'Status', 'Clear filters']);
});

test('Color checks the colors filtered on and a pick toggles one, the menu staying open', async () => {
    await render();
    await openSubmenu('Color');
    expect(checkRows().slice(0, 2)).toEqual([
        [name(first.label), 'true'],
        [name(second.label), 'false'],
    ]);
    await clickRow(name(second.label));
    expect(toggleColor.mock.calls).toEqual([[second.value]]);
    expect(checkRows().length).toBe(EIGEN_STICKIES_COLORS[0].length);
});

test('Status checks the status filtered on and a pick sets it', async () => {
    await render();
    await openSubmenu('Status');
    expect(checkRows()).toEqual([
        ['Open', 'false'],
        ['Resolved', 'true'],
        ['All', 'false'],
    ]);
    await clickRow('Open');
    expect(setStatus.mock.calls).toEqual([['open']]);
});

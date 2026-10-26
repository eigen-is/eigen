// A card's color is a choice: a submenu of the sticky colors, the card's checked.
import { afterEach, expect, mock, test } from 'bun:test';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import { installHappyDom } from '../../happy-dom';
import { checkRows, clickRow, menuRows, openSubmenu, renderOpenMenu } from '../../menu-rows';

installHappyDom();

const { createElement } = await import('react');
const { CommentMenuItems } = await import('../../../components/comments/comment-menu-items');

let unmount = async () => {};
afterEach(() => unmount());

const [first, second] = EIGEN_STICKIES_COLORS[0];

test("Sticky color checks the card's color and a pick recolors the card", async () => {
    const onChangeColor = mock((_id: string, _color: string) => {});
    const card = { id: 'card-1', title: 'Plan', description: '', color: second.value };
    ({ unmount } = await renderOpenMenu(
        createElement(CommentMenuItems, { item: { card, entry: undefined }, noun: 'sticky', onChangeColor }),
    ));
    expect(menuRows()).toEqual(['Sticky color']);
    await openSubmenu('Sticky color');
    expect(checkRows().slice(0, 2)).toEqual([
        [first.label, 'false'],
        [second.label, 'true'],
    ]);
    await clickRow(first.label);
    expect(onChangeColor.mock.calls).toEqual([['card-1', first.value]]);
});

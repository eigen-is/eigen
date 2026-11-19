// A mouse click on a navigation menu's open trigger leaves it open, since the resting mouse opened it a moment before.
// A click from a tap or a key still toggles it.
import { expect, test } from 'bun:test';
import { act } from 'react';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { NavigationMenu, NavigationMenuContent, NavigationMenuItem, NavigationMenuList, NavigationMenuTrigger } =
    await import('../../components/navigation-menu');

async function renderMenu(): Promise<HTMLElement> {
    const { container } = await renderInDocument(
        <NavigationMenu>
            <NavigationMenuList>
                <NavigationMenuItem>
                    <NavigationMenuTrigger>Apps</NavigationMenuTrigger>
                    <NavigationMenuContent>Mail</NavigationMenuContent>
                </NavigationMenuItem>
            </NavigationMenuList>
        </NavigationMenu>,
    );
    const trigger = container.querySelector('button');
    if (!trigger) throw new Error('no trigger');
    return trigger;
}

async function click(trigger: HTMLElement, pointerType: string) {
    await act(async () => {
        trigger.dispatchEvent(new PointerEvent('click', { bubbles: true, cancelable: true, pointerType }));
    });
}

test('a mouse click keeps an open menu open', async () => {
    const trigger = await renderMenu();
    await click(trigger, 'mouse');
    expect(trigger.dataset['state']).toBe('open');
    await click(trigger, 'mouse');
    expect(trigger.dataset['state']).toBe('open');
});

test('a tap toggles it', async () => {
    const trigger = await renderMenu();
    await click(trigger, 'touch');
    expect(trigger.dataset['state']).toBe('open');
    await click(trigger, 'touch');
    expect(trigger.dataset['state']).toBe('closed');
});

test('a key toggles it', async () => {
    const trigger = await renderMenu();
    await click(trigger, 'mouse');
    await act(async () => {
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(trigger.dataset['state']).toBe('closed');
});

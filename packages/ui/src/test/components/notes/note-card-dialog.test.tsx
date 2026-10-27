// Ticking the last box of a card's checklist celebrates: once per opening, only for a list of two or more,
// only on the tick itself, and never with the setting off. The chance is forced to win throughout. Each click
// is saved and drawn again, as a card's parent does, which replaces the boxes in the page.
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { UserSettings } from '@workspace/lib/types/settings';
import { installHappyDom } from '../../happy-dom';

const window = installHappyDom();

let settings: UserSettings = {};
const realSpace = await import('@workspace/lib/space');
mock.module('@workspace/lib/space', () => ({
    ...realSpace,
    useSpaceSettings: () => ({ data: settings }),
}));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const confetti = await import('../../../components/celebrate/confetti-burst');
const { NoteCardDialog } = await import('../../../components/notes/note-card-dialog');

const burst = spyOn(confetti, 'burstConfetti').mockImplementation(() => {});
const roll = spyOn(Math, 'random').mockReturnValue(0);
// A spy outlives its file, so later files get the real ones back.
afterAll(() => {
    burst.mockRestore();
    roll.mockRestore();
});

const item = (checked: boolean, text: string) =>
    `<li data-checked="${checked}" data-type="taskItem"><label><input type="checkbox"${checked ? ' checked' : ''}></label><div><p>${text}</p></div></li>`;
const twoItems = `<ul data-type="taskList">${item(true, 'Buy paint')}${item(false, 'Paint the shed')}</ul>`;

let root = createRoot(document.createElement('div'));
let saved = '';

function render(open: boolean, description: string) {
    saved = description;
    act(() =>
        root.render(
            createElement(NoteCardDialog, {
                open,
                onOpenChange: () => {},
                title: 'Shed',
                description,
                canWrite: true,
                onDescriptionChange: (html: string) => {
                    saved = html;
                },
                children: null,
            }),
        ),
    );
}

function click(text: string) {
    const li = [...document.querySelectorAll('li[data-checked]')].find((el) => el.textContent === text);
    act(() => li?.querySelector('input')?.click());
    render(true, saved);
}

beforeEach(() => {
    settings = {};
    burst.mockClear();
    window.happyDOM.settings.device.prefersReducedMotion = 'no-preference';
    root = createRoot(document.createElement('div'));
    render(false, twoItems);
});
afterEach(() => act(() => root.unmount()));

test('the tick that completes the list celebrates from that box', () => {
    render(true, twoItems);
    click('Paint the shed');
    expect(burst).toHaveBeenCalledTimes(1);
});

test('under reduced motion the ticked box glows, the one in the page after the description is drawn again', () => {
    window.happyDOM.settings.device.prefersReducedMotion = 'reduce';
    render(true, twoItems);
    click('Paint the shed');
    expect(burst).not.toHaveBeenCalled();
    const glowing = [...document.querySelectorAll('input')].filter((box) => box.getAnimations().length > 0);
    expect(glowing.map((box) => box.closest('li')?.textContent)).toEqual(['Paint the shed']);
});

test('unticking does not celebrate', () => {
    render(true, `<ul data-type="taskList">${item(true, 'Buy paint')}${item(true, 'Paint the shed')}</ul>`);
    click('Paint the shed');
    expect(burst).not.toHaveBeenCalled();
});

test('a tick that leaves a box open does not celebrate', () => {
    render(true, `<ul data-type="taskList">${item(false, 'Buy paint')}${item(false, 'Paint the shed')}</ul>`);
    click('Paint the shed');
    expect(burst).not.toHaveBeenCalled();
});

test('re-completing in the same opening does not celebrate again, a new opening does', () => {
    render(true, twoItems);
    click('Paint the shed');
    click('Paint the shed');
    click('Paint the shed');
    expect(burst).toHaveBeenCalledTimes(1);

    render(false, twoItems);
    render(true, twoItems);
    click('Paint the shed');
    expect(burst).toHaveBeenCalledTimes(2);
});

test('a one-item list does not celebrate', () => {
    render(true, `<ul data-type="taskList">${item(false, 'Paint the shed')}</ul>`);
    click('Paint the shed');
    expect(burst).not.toHaveBeenCalled();
});

test('a tick whose save never lands does not celebrate a later edit after the dialog closed', () => {
    render(true, twoItems);
    const li = [...document.querySelectorAll('li[data-checked]')].find((el) => el.textContent === 'Paint the shed');
    act(() => li?.querySelector('input')?.click());
    // The save failed, so the parent never draws the ticked list. The dialog closes and opens again, and
    // then a peer's edit reaches the card.
    render(false, twoItems);
    render(true, twoItems);
    render(true, `<ul data-type="taskList">${item(true, 'Buy paint')}${item(false, 'Paint the fence')}</ul>`);
    expect(burst).not.toHaveBeenCalled();
});

test('the setting off does not celebrate', () => {
    settings = { celebrations: false };
    render(true, twoItems);
    click('Paint the shed');
    expect(burst).not.toHaveBeenCalled();
});

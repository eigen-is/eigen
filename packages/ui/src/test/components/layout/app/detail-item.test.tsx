// An opened item's body is one anatomy: its block on top, square, in the paler panel tone of its color or muted
// without one, with its title inside; a muted meta line; then sections under a small-caps caption, 24px apart.
import { expect, test } from 'bun:test';
import { eigenColor } from '@workspace/lib/constants/colors';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const { DetailItemBlock, DetailMeta, DetailSection } = await import('../../../../components/layout/app/detail-item');
const { colorSurface } = await import('../../../../lib/color-surface');

test("a block carries its title and content, in its color's panel tone", async () => {
    const color = eigenColor('orange', 100);
    const { container } = await renderInDocument(
        <DetailItemBlock title="Lunch" color={color}>
            <p>12:00 – 13:00</p>
        </DetailItemBlock>,
    );
    const block = container.firstElementChild;
    if (!(block instanceof HTMLElement)) throw new Error('no block rendered');
    expect(block.className.split(' ')).toEqual(expect.arrayContaining(['eigen-block', 'bg-(--surface-bg)']));
    expect(block.style.getPropertyValue('--surface-bg')).toBe(colorSurface(color, 'panel').style['--surface-bg']);
    expect(block.querySelector('h2')?.textContent).toBe('Lunch');
    expect(block.textContent).toBe('Lunch12:00 – 13:00');
});

test('a block without a color is muted', async () => {
    const { container } = await renderInDocument(<DetailItemBlock title="Lunch" />);
    const block = container.firstElementChild;
    expect(block?.className.split(' ')).toEqual(expect.arrayContaining(['eigen-block', 'bg-muted']));
    expect(block?.getAttribute('style')).toBeNull();
});

test('a meta line is muted small text', async () => {
    const { container } = await renderInDocument(<DetailMeta>Created by Ada</DetailMeta>);
    expect(container.firstElementChild?.className.split(' ')).toEqual(
        expect.arrayContaining(['text-xs', 'text-muted-foreground']),
    );
    expect(container.textContent).toBe('Created by Ada');
});

test('a section is its caption over its rows, and may be a caption alone', async () => {
    const { container } = await renderInDocument(
        <>
            <DetailSection label="Location">
                <p>Grote Markt</p>
            </DetailSection>
            <DetailSection label="Activity" />
        </>,
    );
    const [location, activity] = [...container.querySelectorAll('section')];
    expect(location?.className.split(' ')).toEqual(expect.arrayContaining(['mt-6', 'text-sm']));
    expect(location?.querySelector('h3.eigen-section-label')?.textContent).toBe('Location');
    expect(location?.textContent).toBe('LocationGrote Markt');
    expect(activity?.textContent).toBe('Activity');
});

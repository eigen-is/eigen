// A card in a color looks the same on the board and open: the tile and the opened body draw the one shared color
// surface, so both get the same fill, text, stripe and dark-mode wash.
import { expect, mock, test } from 'bun:test';
import { eigenColor } from '@workspace/lib/constants/colors';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: null }) }));
const realSpace = await import('@workspace/lib/space');
mock.module('@workspace/lib/space', () => ({ ...realSpace, useSpaceSettings: () => ({ data: {} }) }));

const { CardTile } = await import('../../../components/cards/card-tile');
const { CardBody } = await import('../../../components/cards/card-body');
const { colorSurface } = await import('../../../lib/color-surface');

const SURFACE_VARIABLES = ['--surface-bg', '--surface-fg', '--surface-indicator', '--surface-soft'] as const;

async function surfaceOf(element: React.ReactElement) {
    const { container } = await renderInDocument(element);
    const surface = container.querySelector('[style*="--surface-bg"]');
    if (!(surface instanceof HTMLElement)) throw new Error('no color surface rendered');
    return {
        classes: surface.className.split(' '),
        variables: SURFACE_VARIABLES.map((name) => surface.style.getPropertyValue(name)),
    };
}

test('a tile and an opened card in the same color get the same surface', async () => {
    const color = eigenColor('orange', 100);
    const tile = await surfaceOf(<CardTile title="A card" color={color} />);
    const body = await surfaceOf(<CardBody title="A card" color={color} />);
    expect(body.variables).toEqual(tile.variables);
    expect(tile.variables).toEqual(SURFACE_VARIABLES.map((name) => colorSurface(color).style[name]));
    for (const { classes } of [tile, body]) {
        expect(classes).toEqual(expect.arrayContaining(colorSurface(color).className.split(' ')));
    }
});

import { describe, expect, test } from 'bun:test';
import type { VectorElement, VectorFrame } from '@workspace/lib/vector';
import {
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_SHAPE_TEXT_PROPS,
    SLIDE_SIZES,
    solidFill,
    textualDefaults,
    VECTOR_STYLE_DEFAULTS,
} from '@workspace/lib/vector';
import { installHappyDom } from '../../../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useActiveFrame } = await import('../../../../components/vector/hooks/use-active-frame');
const { useSelection } = await import('../../../../components/vector/hooks/use-selection');

type Deck = ReturnType<typeof useActiveFrame> & ReturnType<typeof useSelection>;
type Props = { frames: VectorFrame[]; elements: VectorElement[] };

const frame = (id: string, index: string): VectorFrame => ({
    id,
    index,
    name: id,
    ...SLIDE_SIZES['16:9'],
    background: '',
});

const box = (id: string, frameId: string): VectorElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    ...textualDefaults(VECTOR_STYLE_DEFAULTS, DEFAULT_SHAPE_TEXT_PROPS),
    roughness: 1,
    autoFit: false,
    id,
    type: 'rectangle',
    fill: solidFill('#dddddd'),
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0,
    seed: 1,
    index: 'a0',
    corners: 'straight',
    frameId,
});

const A = frame('fa', 'a0');
const B = frame('fb', 'a1');
const ELEMENTS = [box('onA', 'fa'), box('onB', 'fb')];

// The deck shell's wiring: one selection, and the active frame that keeps it to its own slide.
function Harness({ frames, elements, onRender }: Props & { onRender: (deck: Deck) => void }) {
    const selection = useSelection();
    const active = useActiveFrame(frames, elements, selection.setSelectedIds);
    onRender({ ...selection, ...active });
    return null;
}

// Mounts on slide B with its box selected, the state the bug starts from.
function mountOnB() {
    let latest: Deck | null = null;
    const root = createRoot(document.createElement('div'));
    const render = (props: Props) =>
        act(() => root.render(createElement(Harness, { ...props, onRender: (deck) => (latest = deck) })));
    const deck = () => {
        if (!latest) throw new Error('harness did not render');
        return latest;
    };
    render({ frames: [A, B], elements: ELEMENTS });
    act(() => deck().setFrameId('fb'));
    act(() => deck().setSelectedIds(['onB']));
    expect(deck().selectedIds).toEqual(['onB']);
    return { deck, render };
}

describe('useActiveFrame keeps the selection to the shown slide', () => {
    test('choosing another slide drops the selection of the one left', () => {
        const { deck } = mountOnB();
        act(() => deck().setFrameId('fa'));
        expect(deck().frameId).toBe('fa');
        expect(deck().selectedIds).toEqual([]);
    });

    test('stepping to another slide drops it too', () => {
        const { deck } = mountOnB();
        act(() => deck().step(-1));
        expect(deck().frameId).toBe('fa');
        expect(deck().selectedIds).toEqual([]);
    });

    test('a slide that vanishes under an undo or a peer hands over without its selection', () => {
        const { deck, render } = mountOnB();
        render({ frames: [A], elements: ELEMENTS });
        expect(deck().frameId).toBe('fa');
        expect(deck().selectedIds).toEqual([]);
    });

    test('a reveal that goes to a slide and selects on it in one go keeps its pick', () => {
        const { deck } = mountOnB();
        act(() => {
            deck().setFrameId('fa');
            deck().setSelectedIds(['onA']);
        });
        expect(deck().selectedIds).toEqual(['onA']);
    });

    test('a render that keeps the slide keeps the selection', () => {
        const { deck, render } = mountOnB();
        render({ frames: [A, B], elements: [...ELEMENTS] });
        expect(deck().selectedIds).toEqual(['onB']);
    });
});

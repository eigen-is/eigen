// useCelebrate rolls the chance, honors the setting, and under reduced motion glows the origin instead of drawing.
import { afterAll, beforeEach, expect, mock, spyOn, test } from 'bun:test';
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
const { useCelebrate } = await import('../../../components/celebrate/use-celebrate');

const burst = spyOn(confetti, 'burstConfetti').mockImplementation(() => {});
const roll = spyOn(Math, 'random');
// A spy outlives its file, so the burst's own test gets the real one back.
afterAll(() => {
    burst.mockRestore();
    roll.mockRestore();
});

beforeEach(() => {
    settings = {};
    burst.mockClear();
    roll.mockReturnValue(0);
    window.happyDOM.settings.device.prefersReducedMotion = 'no-preference';
});

function celebrateFrom(origin: HTMLElement) {
    let celebrate: ((origin: HTMLElement) => void) | undefined;
    function Probe() {
        celebrate = useCelebrate();
        return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Probe)));
    celebrate?.(origin);
    act(() => root.unmount());
}

test('a winning roll bursts from the origin', () => {
    const origin = document.createElement('input');
    celebrateFrom(origin);
    expect(burst).toHaveBeenCalledTimes(1);
    expect(origin.getAnimations()).toHaveLength(0);
});

test('a losing roll draws nothing', () => {
    roll.mockReturnValue(0.5);
    celebrateFrom(document.createElement('input'));
    expect(burst).not.toHaveBeenCalled();
});

test('the setting turned off draws nothing', () => {
    settings = { celebrations: false };
    celebrateFrom(document.createElement('input'));
    expect(burst).not.toHaveBeenCalled();
});

test('reduced motion draws nothing and glows the origin instead', () => {
    window.happyDOM.settings.device.prefersReducedMotion = 'reduce';
    const origin = document.createElement('input');
    document.body.append(origin);
    celebrateFrom(origin);
    expect(burst).not.toHaveBeenCalled();
    expect(document.querySelector('canvas')).toBeNull();
    expect(origin.getAnimations()).toHaveLength(1);
    origin.remove();
});

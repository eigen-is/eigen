import { expect, test } from 'bun:test';
import type { RestartNoticeState } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { handleRestartNoticeSSEvent, setStreamDown } from '../../../../core/sse/restart-notice';
import { installHappyDom } from '../../../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useRestartNotice } = await import('../../../../core/sse/hooks/use-restart-notice');

test('a component re-renders with each notice and each change of the stream', async () => {
    // The store is the module's, so another test file may have left a notice in it.
    handleRestartNoticeSSEvent({ type: SSEventType.SERVER_RESTART_NOTICE, notice: null });
    setStreamDown(false);
    const seen: RestartNoticeState[] = [];
    function Harness() {
        seen.push(useRestartNotice());
        return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Harness)));
    await act(async () =>
        handleRestartNoticeSSEvent({
            type: SSEventType.SERVER_RESTART_NOTICE,
            notice: { reason: 'rollback', msLeft: 60_000, message: null },
        }),
    );
    await act(async () => setStreamDown(true));
    await act(async () => root.unmount());
    handleRestartNoticeSSEvent({ type: SSEventType.SERVER_RESTART_NOTICE, notice: null });
    setStreamDown(false);

    expect(seen.map(({ notice, streamDown }) => [notice?.reason ?? null, streamDown])).toEqual([
        [null, false],
        ['rollback', false],
        ['rollback', true],
    ]);
});

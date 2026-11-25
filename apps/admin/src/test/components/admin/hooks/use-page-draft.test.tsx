// A page draft starts empty and unchanged, shows the loaded values with the draft applied, reads as unchanged again
// once a value is put back by hand, and reset drops the draft.
import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { usePageDraft } = await import('../../../../components/admin/hooks/use-page-draft');

type Loaded = { quotas: { upload: number; trash: number } };
const LOADED: Loaded = { quotas: { upload: 35, trash: 30 } };

test('the draft applies over what loaded, and changed follows the values, not the edits', async () => {
    let latest: ReturnType<typeof usePageDraft<Loaded, Loaded>> | undefined;
    function Probe() {
        latest = usePageDraft(LOADED, (loaded, draft) => ({ quotas: { ...loaded.quotas, ...draft.quotas } }));
        return null;
    }
    const { unmount } = await renderInDocument(createElement(Probe));
    const draft = () => {
        if (!latest) throw new Error('the probe never rendered');
        return latest;
    };
    expect(draft().changed).toBe(false);
    expect(draft().current).toEqual(LOADED);

    await act(async () => draft().setDraft({ quotas: { upload: 50 } }));
    expect(draft().changed).toBe(true);
    expect(draft().current).toEqual({ quotas: { upload: 50, trash: 30 } });
    expect(draft().loaded).toEqual(LOADED);

    await act(async () => draft().setDraft({ quotas: { upload: 35 } }));
    expect(draft().changed).toBe(false);

    await act(async () => draft().setDraft({ quotas: { trash: 0 } }));
    await act(async () => draft().reset());
    expect(draft().draft).toEqual({});
    expect(draft().changed).toBe(false);
    await unmount();
});

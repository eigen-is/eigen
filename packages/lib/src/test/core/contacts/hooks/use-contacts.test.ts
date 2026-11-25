// A contact write that meets a 412 says the card changed elsewhere and reloads the list, instead of the generic error
// toast. That toast counts as shown, so a dialog that awaits the write drops the rejection instead of logging it. The
// profile's Save leaves its page, so it says "Profile saved", and a plain contact save says nothing.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderHook } from '../../../render-hook';
import { hasKey, installTransferHarness, OWNER, toasts, trackingClient } from '../../../transfer-harness';

installTransferHarness();

const stale = { data: null, error: { status: 412, value: 'Precondition failed' }, status: 412 };
const saved = { data: {}, error: null, status: 200 };
let reply: typeof stale | typeof saved = stale;
const realApiModule = await import('../../../../core/api');
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    contactsApi: () => ({
        contacts: () => ({
            put: async () => reply,
            delete: async () => reply,
        }),
    }),
}));

afterAll(() => {
    mock.module('../../../../core/api', () => realApiModule);
});

const { act } = await import('react');
const { wasToasted } = await import('../../../../core/api-error');
const { useDeleteContact, useUpdateContact, useUpdateProfile } = await import(
    '../../../../core/contacts/hooks/use-contacts'
);
const { contactKeys } = await import('../../../../core/contacts/hooks/keys');

const ada = { firstName: 'Ada', lastName: 'Lovelace', email: ['ada@example.org'], phone: [] };

beforeEach(() => {
    toasts.length = 0;
    reply = stale;
});

describe('a write that meets a 412', () => {
    test('an update says the contact changed elsewhere, reloads the list, and counts as toasted', async () => {
        const { queryClient, invalidated } = trackingClient();
        const { latest, unmount } = await renderHook(() => useUpdateContact(), queryClient);
        let failure: unknown = null;
        await act(async () => {
            await latest.mutateAsync({ ...ada, id: 'c1', etag: '1' }).catch((error: unknown) => (failure = error));
        });
        await unmount();
        expect(toasts).toEqual([
            'error: This contact changed elsewhere. What you typed is still here. Check it and save again.',
        ]);
        expect(hasKey(invalidated, contactKeys.lists(OWNER))).toBe(true);
        expect(wasToasted(failure)).toBe(true);
    });

    test('a delete says so without promising anything typed, reloads the list, and counts as toasted', async () => {
        const { queryClient, invalidated } = trackingClient();
        const { latest, unmount } = await renderHook(() => useDeleteContact(), queryClient);
        let failure: unknown = null;
        await act(async () => {
            await latest.mutateAsync({ id: 'c1', etag: '1' }).catch((error: unknown) => (failure = error));
        });
        await unmount();
        expect(toasts).toEqual(['error: This contact changed elsewhere. Check it and try again.']);
        expect(hasKey(invalidated, contactKeys.lists(OWNER))).toBe(true);
        expect(wasToasted(failure)).toBe(true);
    });
});

test('a profile save says it saved and reloads the list, and a contact save says nothing', async () => {
    reply = saved;
    const { queryClient, invalidated } = trackingClient();
    const profile = await renderHook(() => useUpdateProfile(), queryClient);
    const contact = await renderHook(() => useUpdateContact(), queryClient);
    await act(async () => {
        await profile.latest.mutateAsync({ ...ada, id: 'me', etag: '1' });
        await contact.latest.mutateAsync({ ...ada, id: 'c1', etag: '1' });
    });
    await profile.unmount();
    await contact.unmount();
    expect(toasts).toEqual(['success: Profile saved']);
    expect(hasKey(invalidated, contactKeys.lists(OWNER))).toBe(true);
});

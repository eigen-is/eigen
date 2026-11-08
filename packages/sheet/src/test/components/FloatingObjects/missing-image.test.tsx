// An image draws what the document's media resolver says of its name: its file, a placeholder while the listing has no
// such name, the missing look once it can't resolve. The resolver's answer changes without any change to the workbook.
import { afterEach, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { driveKeys, MediaResolverProvider } from '@workspace/lib/drive';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
type Sheet = import('../../../state').Sheet;

const OWNER = 'owner-1';
const MOUNT = 'default';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

async function mount(mediaFolderId: string | null, queryClient: QueryClient) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const data: Sheet[] = [
        {
            id: 's1',
            name: 'One',
            order: 0,
            row: 20,
            column: 5,
            celldata: [],
            config: {},
            images: { gone: { id: 'gone', index: 'a0', mediaName: 'gone.png', x: 10, y: 10, width: 50, height: 50 } },
        },
    ];
    await act(async () => {
        root.render(
            <QueryClientProvider client={queryClient}>
                <MediaResolverProvider
                    ownerId={OWNER}
                    mountId={MOUNT}
                    mediaFolderId={mediaFolderId}
                    chatFolderId={null}
                >
                    <Workbook data={data} hooks={{}} />
                </MediaResolverProvider>
            </QueryClientProvider>,
        );
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return container;
}

// An image whose file is gone draws as missing, and must still select like any image, so Delete removes it.
test('a missing image selects on click and Delete removes it', async () => {
    const container = await mount(null, new QueryClient());

    const image = container.querySelector<HTMLElement>('[data-floating-id="gone"]')?.firstElementChild;
    if (!(image instanceof HTMLElement)) throw new Error('the missing image did not draw');
    await act(async () => image.click());
    expect(container.querySelector('[data-floating-id="gone"]')?.getAttribute('data-active')).toBe('true');

    // The key goes where the user's focus is, so the selected image must hold it.
    await act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    expect(container.querySelector('[data-floating-id="gone"]')).toBeNull();
});

test('an image draws its file once the listing holds it, with no write to the workbook', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } } });
    const key = driveKeys.folder(OWNER, MOUNT, 'media');
    queryClient.setQueryData(key, []);
    const container = await mount('media', queryClient);
    const img = () => container.querySelector('[data-floating-id="gone"] img');
    expect(img()).toBeNull();
    await act(async () => {
        queryClient.setQueryData(key, [drivePath({ name: 'gone.png', mimeType: 'image/png' })]);
        // The query cache tells its observers on a timer.
        await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(img()).not.toBeNull();
});

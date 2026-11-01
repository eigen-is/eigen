// Browser print of one element, such as an open document, an email or a contact. It prints a copy of the
// element, which the print stylesheet shows alone on the page. ⌘P and the apps' print buttons call it, and
// so does Docs when its server PDF can't print.

// Prints the `[data-document]` element alone; an app without one gets the browser's print of the page.
export function printDocument() {
    const el = document.querySelector<HTMLElement>('[data-document]');
    if (el) printElement(el).catch(() => {});
    else window.print();
}

// Print lays the page out once and draws only what has loaded by then. So the copy waits for its images, and for
// the font slices still loading: each face is cut into unicode-range slices, and the on-screen element has asked
// for the ones its text needs. A broken image prints as it shows.
export async function printElement(el: HTMLElement): Promise<void> {
    const cloned = el.cloneNode(true);
    if (!(cloned instanceof HTMLElement)) return;
    document.body.appendChild(cloned);
    cloned.classList.add('printable');
    const images = [...cloned.querySelectorAll('img')].map((img) => img.decode().catch(() => {}));
    await Promise.all([document.fonts.ready, ...images]);
    window.print();
    cloned.remove();
}

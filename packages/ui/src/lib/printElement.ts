// add `data-document` attribute to the document element, this element will be printed
// returns true if attribute was found, false otherwise
export function printDocument(): boolean {
    const el = document.querySelector('[data-document]')! as HTMLElement;
    if (el) {
        printElement(el);
        return true;
    } else {
        console.warn('`data-document` not found');
        window.print();
        return false;
    }
}

// source: <https://stackoverflow.com/a/70304461/508029>
export function printElement(el: HTMLElement) {
    const cloned = el.cloneNode(true) as HTMLElement;
    document.body.appendChild(cloned);
    cloned.classList.add('printable');
    // Delay to allow the browser to finish layout recalculation of the cloned element before printing
    setTimeout(() => {
        window.print();
        document.body.removeChild(cloned);
    }, 450);
}

// Prints the `[data-document]` element alone; an app without one gets the browser's print of the page.
export function printDocument() {
    const el = document.querySelector<HTMLElement>('[data-document]');
    if (el) printElement(el);
    else window.print();
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

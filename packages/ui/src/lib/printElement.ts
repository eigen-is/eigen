// source: <https://stackoverflow.com/a/70304461/508029>
export function printElement(el: HTMLElement) {
  let cloned = el.cloneNode(true) as HTMLElement;
  document.body.appendChild(cloned);
  cloned.classList.add("printable");
  window.print();
  document.body.removeChild(cloned);
}
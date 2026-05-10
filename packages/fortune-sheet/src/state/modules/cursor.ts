export function moveToEnd(obj: HTMLDivElement) {
    if (obj.innerHTML !== obj.innerText || obj.innerHTML === '') {
        obj.focus(); // Fix Firefox not being able to position cursor without focus
        const range = window.getSelection(); // Create range
        range?.selectAllChildren(obj); // Select all child content of obj within the range
        range?.collapseToEnd(); // Move cursor to the end
    } else {
        const len = obj.innerText.length;
        const range = document.createRange();
        range.selectNodeContents(obj);
        range.setStart(obj.childNodes[0], len);
        range.collapse(true);

        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
    }
}

function isInPage(node: Node) {
    return node === document.body ? false : document.body.contains(node);
}

export function selectTextContent(ele: HTMLElement) {
    const range = document.createRange();
    const content = ele.firstChild as Text;
    if (content) {
        range.setStart(content, 0);
        range.setEnd(content, content.length);
        if (range.startContainer && isInPage(range.startContainer)) {
            window.getSelection()?.removeAllRanges();
            window.getSelection()?.addRange(range);
        }
    }
}

export function selectTextContentCross(sEle: HTMLElement, eEle: HTMLElement) {
    if (window.getSelection) {
        const range = document.createRange();
        const sContent = sEle.firstChild;
        const eContent = eEle.firstChild as Text;
        if (sContent && eContent) {
            range.setStart(sContent, 0);
            range.setEnd(eContent, eContent.length);
            if (range.startContainer && isInPage(range.startContainer)) {
                window.getSelection()?.removeAllRanges();
                window.getSelection()?.addRange(range);
            }
        }
    }
}

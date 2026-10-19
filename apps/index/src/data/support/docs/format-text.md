---
title: "Format text"
description: "Apply bold, headings, lists, alignment, indents, line spacing, colors, fonts, and text sizes to text in a Docs document using the toolbar."
type: how-to
category: Editing
tags: [docs, formatting, fonts, font size, headings, normal text, lists, numbering, color, alignment, indent, line spacing, caps]
related: [docs/clear-formatting, docs/create-and-edit]
order: 30
updated: 2026-10-19
---

Docs has a full formatting toolbar above the editor. You can change the font and its size, set headings, make text bold or italic, pick a color, align paragraphs, and build lists, all without leaving the page.

The toolbar is visible whenever you have write access to the document. If you can only view, the toolbar is hidden.

On a narrower window the toolbar shows fewer formatting buttons, and on a small screen none. Everything on this page except typing a text size is also in the **Format** menu in the toolbar, which works on any screen.

## Choose a font

Click the font name in the toolbar, or open **Format**, then **Font**. A dropdown shows the four available fonts:

- **Inter** (the default, a clean sans-serif)
- **Source Serif 4** (a serif font, good for long-form reading)
- **JetBrains Mono** (monospaced, suited to code or technical content)
- **Excalifont** (a hand-drawn style)

Click the name you want. The change applies to the selected text. If nothing is selected, it applies to new text you type from that point.

## Change the text size

The size box sits between the font name and **Bold**. It shows the size of the selected text in points, such as 11 for normal text. When the selection mixes sizes, the box is empty.

- Click **Decrease font size** (the minus button) or **Increase font size** (the plus button) to make the text one point smaller or larger. In a selection that mixes sizes, each part changes by one point.
- To set a size, click the box, type a size from 1 to 400, such as 14 or 10.5, and press Enter. Press Escape to leave the size as it was.

You can also open **Format**, then **Text**, then **Size**, and choose **Increase font size** (Cmd+Shift+. / Ctrl+Shift+.) or **Decrease font size** (Cmd+Shift+, / Ctrl+Shift+,).

## Apply a paragraph style

The style selector sits next to the font picker. It shows the current style of the cursor position, such as **Normal text** or **Heading 2**.

1. Click inside the paragraph you want to change, or select several lines.
2. Click the style selector to open the dropdown, or open **Format**, then **Paragraph styles**.
3. Choose **Normal text**, **Title**, **Subtitle**, or one of **Heading 1** through **Heading 6**. In the **Format** menu, **Normal text** opens a menu of its own: choose **Apply 'Normal text'**.

These are block styles: the whole paragraph changes, not just the selected words. Choosing **Normal text** removes the style and returns the paragraph to the default style.

## Change the document's normal text

Normal text is the font, size, color, line spacing, and space before and after that text uses when you haven't changed them. A new document's normal text is Inter at 11 points.

1. Click inside a paragraph of text that looks the way you want normal text to look. The item is available in normal paragraphs of the document, not in a heading, a title, a header, or a footer.
2. Open **Format**, then **Paragraph styles**, then **Normal text**, and choose **Update 'Normal text' to match**.

All text that doesn't have its own font, size, or color, and every paragraph that doesn't have its own spacing, changes to match, in the editor, the preview, and every download. Text you formatted yourself keeps its formatting, and headings keep their own size and spacing. To go back, press Cmd+Z / Ctrl+Z.

To set paragraphs off as a quote, open **Format**, then **Paragraph styles**, and choose **Quote**. Choose it again to turn the quote back into normal paragraphs.

## Make text bold, italic, or underlined

Select the text you want to change, then click the button in the toolbar:

- **Bold** (or Cmd+B / Ctrl+B)
- **Italic** (or Cmd+I / Ctrl+I)
- **Underline** (or Cmd+U / Ctrl+U)

Each button is a toggle. Click it again on the same selection to remove the style. When the cursor is inside styled text, the button appears highlighted, so you can see what is active.

For more styles, open **Format**, then **Text**. Next to **Bold**, **Italic**, and **Underline** it has **Strikethrough**, **Superscript**, **Subscript**, and **Inline code**. Choose a style again on the same selection to remove it.

## Set text in capitals

Select the text, then open **Format**, then **Text**, and choose **All caps** (or press Cmd+Shift+A / Ctrl+Shift+A) or **Small caps**. All caps shows every letter as a capital. Small caps shows lowercase letters as smaller capitals. The letters you typed stay as they are, so choosing the style again brings them back.

## Set a text color

The text color button shows a letter A with a colored underline reflecting the current color.

1. Select the text you want to color.
2. Click the **Text color** button in the toolbar, or open **Format**, then **Text**, then **Text color**.
3. A color grid opens. Click the color you want.

To go back to the default color, click **Default** at the top of the grid.

## Highlight text

The **Highlight** button (the highlighter pen icon) works the same way as text color, but paints the background behind the selected text.

1. Select the text.
2. Click the **Highlight** button, or open **Format**, then **Text**, then **Highlight color**.
3. Pick a color from the grid.

To remove the highlight, open the grid and click **None**.

## Align a paragraph

Alignment applies to the whole paragraph the cursor is in, or to all paragraphs in the selection.

- **Left** (the default)
- **Center**
- **Right**
- **Justified**: stretches each line to both margins, except the last line of the paragraph.

Click the **Align** button in the toolbar, which shows the current alignment, and choose one. The current alignment is marked in the list. You can also open **Format**, then **Align and indent**, and choose **Left**, **Center**, **Right**, or **Justified**.

## Indent a paragraph

Open **Format**, then **Align and indent**, and choose **Increase indent** (Cmd+] / Ctrl+]) or **Decrease indent** (Cmd+[ / Ctrl+[). Each step moves the paragraph 1.27 cm. In a list, they move the item one level in or out instead.

For an exact indent, choose **Indentation options…**. Set **Left** and **Right** in centimeters, and under **Special indent** choose **First line** to indent only the first line, or **Hanging** to start the first line that distance left of the others, with the distance beside it. **Left** is where the lines after the first one start. An indent stops at the right edge of the text. Click **Apply**.

## Change line and paragraph spacing

Open **Format**, then **Line & paragraph spacing**:

- **Single**, **1.15**, **1.5**, or **Double** sets the space between the lines of a paragraph. The one the paragraph uses is marked. A paragraph you haven't changed uses the line spacing of the document's normal text, 1.4 in a new document, so none is marked.
- **Add space before paragraph** and **Add space after paragraph** add 12 points above or below the paragraph. Where the paragraph has space there already, the item reads **Remove space before paragraph** or **Remove space after paragraph** and takes it away.
- **Custom spacing…** sets the **Line spacing** and the space **Before** and **After** the paragraph in points. Click **Apply**.

Each of these applies to the paragraph the cursor is in, or to every paragraph in the selection. In a list, a quote, or a table, the space before and after a paragraph is the list's, quote's, or table's own, so you can set only the line spacing there.

## Add a list

Place your cursor on the line where you want the list to start, then click one of the list buttons:

- **Bulleted list**: an unordered list with bullet points.
- **Numbered list**: an ordered list with sequential numbers.
- **Checklist**: a list with tick-box items you can check off.

The same lists are in **Format**, then **Bullets and numbering**: **Numbered list**, **Bulleted list**, and **Checklist**.

Press Enter to add the next item, and press Enter on an empty item to end the list. You can also click the same button again on a selected list to turn it back into regular paragraphs.

### Choose a numbering style

Open **Format**, then **Bullets and numbering**, then **Numbered list**, and choose one of five styles: **1. 2. 3.**, **a. b. c.**, **A. B. C.**, **i. ii. iii.**, or **I. II. III.** On a regular paragraph this starts a numbered list in that style. Inside a numbered list it changes the style of that list. The style of the list the cursor is in is marked.

A numbered list inside another numbered list counts 1. a. i. by level, as in Google Docs: letters one level in, roman numerals two levels in, then numbers again. A list you choose a style for, **1. 2. 3.** included, keeps that style at any level.

### Restart numbering

1. Click in the list item where the new count should begin.
2. Open **Format**, then **Bullets and numbering**, then **List options**, and choose **Restart numbering**.
3. Enter the first number in **Start at** and click **OK**.

On the first item, the whole list starts at that number. On a later item, the list splits in two there, and the second list counts on from your number. **List options** works only when the cursor is in a numbered list.

## Remove all formatting

To strip every style from selected text in one step, click the **Clear formatting** button in the toolbar, or choose **Clear formatting** from the **Format** menu. This removes bold, italic, color, font changes, and any other marks, leaving plain text.

See [Clear formatting](/support/docs/clear-formatting) for more detail on what gets removed and when to use it.

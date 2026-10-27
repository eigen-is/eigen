---
title: "Import a PowerPoint presentation"
description: "Turn a .pptx file into a presentation, add its slides to one you already have, or replace that one's slides with them."
type: how-to
tags: [slides, import, powerpoint, pptx]
related: [slides/export-slides, slides/add-slides]
order: 100
updated: 2026-10-26
---

You can bring a PowerPoint file (`.pptx`) into Slides in two ways: convert it in Drive into a new presentation, or import its slides into a presentation you already have open, next to your own slides or in their place. Its slides come across with their text, shapes, pictures, charts, and backgrounds.

## Convert a PowerPoint file in Drive

1. Open [Drive](/drive) and find the `.pptx` file.
2. Right-click the file (or open the **⋮** menu) and choose **Convert to Slides**.

A **Converting to slides** dialog shows while the file converts. Eigen then creates a new presentation in the same folder, with the same name as the PowerPoint file, and opens it in Slides. The original `.pptx` file stays in place.

## Import into an open presentation

1. Open the presentation in Slides, on the slide you want the new slides to follow.
2. Click **File** in the toolbar.
3. Click **Import…**.
4. In the **Import pptx file** dialog, browse your Drive and select the `.pptx` file, then click **Select**. To use a file from your computer instead, click **Upload from device** and pick the file.
5. Choose how the slides come in, then click **Import**:
   - **Insert slides** adds the file's slides after the current slide. This is the default. Nothing in the presentation is replaced, so your own slides, comments, and undo history stay as they were.
   - **Replace all slides** replaces every slide with the file's, and the presentation takes the file's slide size. Eigen saves a version first, so you can get your slides back from **File → Version history**. See [See and restore previous versions of a file](/support/drive/file-versions).

An **Importing pptx file** dialog shows while the file imports. Pictures from the file are stored with the presentation and count toward your drive's storage: if they don't fit in the space left, the import stops and the presentation stays as it was.

## What comes across

- Every slide, hidden slides included, in the same order. A slide takes its name from its title.
- The slide size. A converted presentation takes 16:9 or 4:3, whichever is closer to the file's, and keeps the file's width, so a 44 pt title still shows 44 pt. Slides added to an open presentation are fitted to its slides, and their text grows or shrinks with them.
- Text keeps its bold, italic, underline, color, size, and alignment. Fonts become Eigen's own: a sans-serif font such as Calibri or Arial shows in Inter, a serif font such as Times New Roman in Source Serif 4, and a monospace font such as Courier New in JetBrains Mono.
- Rectangles, rounded rectangles, ovals, diamonds, pie shapes, lines, and arrows, with their fill and outline.
- Every other shape, such as a star, a block arrow, a flowchart shape, a map outline, or a freeform drawing, with its fill and outline. You can move, resize, and recolor it like any other shape.
- PNG, JPEG, GIF, WebP, and SVG pictures.
- Column, bar, line, and pie charts, with their data, colors, title, background, and text and line colors. They become Slides charts, so you can [edit their data](/support/slides/insert-content) like any other chart. A 3-D chart comes in flat.
- Slide backgrounds: a color, a gradient, or a picture.
- The shapes and pictures of the slide master and layout, such as a logo or a border, on every slide that shows them.

A converted presentation takes the slide size closest to the file's: a widescreen file becomes a **Widescreen 16:9** presentation and a standard file a **Standard 4:3** one, so its slides fill the page. A size in between, such as 16:10 or A4, takes the closer of the two and is fitted inside it. When you insert slides into a presentation of another size, they are fitted inside its slides, centered, with a margin at the sides or at the top and bottom. The presentation keeps its own size. When you replace all slides, the presentation takes the size closest to the file's, as a converted one does.

## What doesn't come across

After an import into an open presentation, a message counts what didn't come across, for example "2 tables and 1 SmartArt graphic were not imported; 5 shapes were simplified."

- A table, SmartArt graphic, or embedded object becomes a box that says what was there, so you can see the gap and rebuild it. The box is see-through, so a title behind it stays readable.
- A chart Slides can't draw the way PowerPoint does, such as an area, scatter, doughnut, or combo chart, becomes a box that names the kind of chart and its title, for example **Scatter chart not imported**. A chart with more than 32 series, or more than 2,000 values in all, becomes a box that says **Chart not imported**, with its title.
- A bent or curved connector, an arc, or a freeform line that isn't closed comes in without its arrowheads. Shadows, glows, and 3-D effects are left out.
- Pictures come in uncropped and unflipped. A TIFF, BMP, EMF, or WMF picture becomes a box that says **Picture not imported**. So does every picture after the first 1,000, or once the pictures add up to more than the largest file you can upload (35 MB unless your administrator changed it).
- A pattern fill becomes a plain color, a gradient keeps its first and last color, and a picture used to fill a shape is left out.
- Within one text box, every line takes the font, size, color, and letter spacing used most in that box. The message after an import counts such a box as a simplified text box.
- Speaker notes, animations, and transitions aren't imported.

A file with no slides converts to a presentation that opens like a new one, with its welcome slide. Imported into an open presentation, it changes nothing, and a message says "This presentation has no slides".

A password-protected file can't be imported, and neither can a macro-enabled presentation (`.pptm`), a template, or a slideshow file. Open it in PowerPoint, save it as a `.pptx` without a password, and import it again.

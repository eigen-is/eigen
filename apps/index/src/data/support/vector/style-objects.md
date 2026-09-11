---
title: "Style shapes, lines, text, and images"
description: "A reference for every section of the properties panel in Vector: transform, text, image, fill, stroke, shape, sketch, and appearance."
type: reference
category: Editing
tags: [vector, styling, fill, stroke, colours, text]
related: [vector/draw-shapes-and-text, vector/connect-with-arrows, vector/arrange-and-align]
order: 50
updated: 2026-09-11
---

Select an object in a drawing and the panel on the right fills with its style controls. The sections change to match what you picked: a shape has a fill, an arrow does not, text has its own typography rows. This page lists every section, in the order it appears, and what each control does.

The panel groups the same fields whether you select one object or several. When a value differs across your selection, the control shows a dash until you set it.

## Transform

Position, size, and rotation. Shown for any selection.

| Control | What it does |
|---|---|
| **X**, **Y** | The object's position on the canvas |
| **W**, **H** | Width and height |
| **Keep aspect ratio** | Locks width and height together while you resize |
| **Angle** | Rotation in degrees |

## Text

Shown only for text objects. It styles the text itself. The box behind the text uses the **Fill** and **Stroke** sections below.

| Control | What it does |
|---|---|
| **Font** | The typeface |
| **Size** | Text size, from 8 to 200 |
| **Color** | Text colour |
| **Style** | **Bold**, **Italic**, **Underline**, and **Strikethrough** toggles |
| **Align** | Horizontal alignment: left, centre, right, or justify |
| **Vertical** | Vertical alignment: top, middle, or bottom |

## Spacing

Shown with the **Text** section, for text objects.

| Control | What it does |
|---|---|
| **Letter** | Letter spacing |
| **Line** | Line height |
| **Padding** | The gap between the text and the edge of its box |

## Image

Shown only for image objects.

| Control | What it does |
|---|---|
| **Fit** | How the picture fills its box: **Stretch**, **Fit**, or **Fill** |

## Fill

The colour inside a shape. Shown for shapes and text, and for a line or drawing whose path is closed. Arrows, images, and open lines have no fill.

| Control | What it does |
|---|---|
| Colour swatch | Fills the object with a solid colour or a two-stop gradient. Choose **None** for no fill. |
| **Style** | How the fill is drawn: **Solid**, **Hachure**, **Cross-hatch**, or **Zigzag** |

## Stroke

The object's outline. Shown for any selection, because every object is drawn with a stroke.

| Control | What it does |
|---|---|
| **Color** | Outline colour. On shapes, text, and images you can set it to **None**. A line or arrow is its stroke, so it always keeps a colour. |
| **Width** | **Thin**, **Medium**, or **Bold** |
| **Style** | **Solid**, **Dashed**, or **Dotted**. Not shown for freehand drawings. |

## Shape

How corners and joins are drawn. Shown when the selected object has either control.

| Control | What it does |
|---|---|
| **Corners** | Corner treatment for boxes: **Straight**, **Curved**, or **Round** |
| **Edges** | How a line bends at each point: **Sharp** or **Rounded** |

## Sketch

The hand-drawn look every object is painted with.

| Control | What it does |
|---|---|
| **Style** | How rough the strokes look: **Architect** (clean), **Artist**, or **Cartoonist** (roughest) |

## Appearance

| Control | What it does |
|---|---|
| **Opacity** | How see-through the object is, from 0 to 100 |

## Arrange and align

The **Arrange** buttons change stacking order, and **Align** appears when you select two or more objects. See [Arrange and align objects](/support/vector/arrange-and-align).

## Which sections appear

Sections show only where they mean something for the object you picked.

| Section | Shown for |
|---|---|
| **Transform**, **Stroke**, **Sketch**, **Appearance** | Every object |
| **Fill** | Shapes and text, plus a closed line or drawing |
| **Text**, **Spacing** | Text |
| **Image** | Images |
| **Shape** (**Corners**) | Rectangles, diamonds, text, and images |
| **Shape** (**Edges**) | Lines |

## Nothing selected

With nothing selected, the panel is titled **Canvas** and shows a single **Background** section. Its **Color** row sets the drawing's background colour, or **None** for a transparent canvas.

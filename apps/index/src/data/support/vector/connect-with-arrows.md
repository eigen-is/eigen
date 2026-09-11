---
title: "Connect objects with arrows and lines"
description: "Draw arrows and lines in a Vector drawing, dock them to shapes so they stay connected, and set their arrowheads."
type: how-to
category: Editing
tags: [vector, arrows, lines, diagram, connectors]
related: [vector/draw-shapes-and-text, vector/style-objects, vector/arrange-and-align]
order: 30
updated: 2026-09-11
---

Arrows and lines let you join objects in a drawing and show how they relate. An arrow can dock to a shape at either end, so it stays attached when you move that shape. This article covers the **Arrow** and **Line** tools. To create the shapes you connect, see [Draw shapes and text](/support/vector/draw-shapes-and-text).

You need editor access to draw. If you can only view the drawing, these tools are not available.

## Connect two shapes with an arrow

1. In the toolbar, select the **Arrow** tool. You can also press **A**, or pick **Arrow** from the **Insert** menu.
2. Move the pointer onto the first shape. An outline appears around it to show the arrow will attach.
3. Press and drag from that shape to the second shape, then release. The arrow docks to both shapes.
4. Move either shape. The arrow follows and stays connected.

## Draw a simple arrow or line

Select the **Arrow** tool (**A**) or the **Line** tool (**L**), then press, drag, and release to draw a straight two-point arrow or line. Hold **Shift** while you drag to lock the angle to steps of 15 degrees.

## Draw a multi-point arrow or line

For a connector with several segments, click to place points instead of dragging:

1. Select the **Arrow** or **Line** tool.
2. Click once on the canvas to start. Each further click adds a point.
3. Finish with **Enter** or a double-click. To cancel and drop the draft, press **Esc**.

While you place points, a hint at the bottom of the canvas reminds you: **Enter or double-click to finish · Esc to cancel**. Hold **Shift** as you click to lock each segment to 15-degree steps.

## Dock an arrow to a shape

When you start or end an arrow on a shape, it docks (snaps) to that shape's edge. You can dock to rectangles, diamonds, ellipses, text boxes, and images. A docked end follows the shape when you move, resize, or rotate it, so the arrow keeps pointing where you meant.

To stop an end docking, hold **Cmd** (Mac) or **Ctrl** (Windows) while you draw or drag it.

## Detach or re-dock an end

Select the arrow, then drag the round handle at one end:

- Drag it away from the shape to detach that end.
- Drag it onto another shape to dock it there instead.

Dragging the whole arrow along with its shape keeps them connected.

## Reshape an arrow or line

Select a single arrow or line. Round dots appear at each point. Drag a dot to move that point. Drag one of the fainter dots between them to add a new point.

## Make an arrow turn at right angles

Select the arrow. In the properties panel on the right, open the **Arrow** section and set **Type** to **Elbow**. The arrow then routes in straight, right-angled segments and bends automatically around the shapes it connects. The other two types are **Sharp**, a straight line, and **Curved**.

With **Elbow** chosen, an **Edges** row appears. Set it to **Sharp** for square corners or **Rounded** for curved ones. To move a bend, drag one of the dots on the arrow's segments. Double-click a dot to reset that segment.

## Choose arrowheads

Select the arrow. In the properties panel, open the **Arrowheads** section. Set the **Start** and **End** ends on their own. Each offers **None**, **Arrow**, **Triangle**, **Bar**, and **Circle**.

To change the colour, width, or dash style of the shaft, use the stroke controls covered in [Style objects](/support/vector/style-objects).

## Add a label to an arrow

Double-click an arrow to type a label on it. Click away when you are done. Once an arrow carries a label, the properties panel adds a **Text** section where you can set its font and **Size**. To remove the label, double-click the arrow and delete the text.

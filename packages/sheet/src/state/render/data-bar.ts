// Conditional-formatting data bar, drawn inside the cell's padded rect.
// Negative bars hardcode red (inherited canvas legacy); positive bars use the
// rule's format colors, gradient when two are given.

import type { DataBar } from '../../engine/conditional-format';

export function drawDataBar(
    renderCtx: CanvasRenderingContext2D,
    dataBar: DataBar,
    x: number,
    y: number,
    w: number,
    h: number,
) {
    const { valueType } = dataBar;
    const { valueLen } = dataBar;
    const { format } = dataBar;

    if (valueType === 'minus') {
        // Negative value
        const { minusLen } = dataBar;

        if (format.length > 1) {
            // Gradient
            const my_gradient = renderCtx.createLinearGradient(
                x + w * minusLen * (1 - valueLen),
                y,
                x + w * minusLen,
                y,
            );
            my_gradient.addColorStop(0, '#ffffff');
            my_gradient.addColorStop(1, '#ff0000');

            renderCtx.fillStyle = my_gradient;
        } else {
            // Solid
            renderCtx.fillStyle = '#ff0000';
        }

        renderCtx.fillRect(x + w * minusLen * (1 - valueLen), y, w * minusLen * valueLen, h);

        renderCtx.beginPath();
        renderCtx.moveTo(x + w * minusLen * (1 - valueLen), y);
        renderCtx.lineTo(x + w * minusLen * (1 - valueLen), y + h);
        renderCtx.lineTo(x + w * minusLen, y + h);
        renderCtx.lineTo(x + w * minusLen, y);
        renderCtx.lineTo(x + w * minusLen * (1 - valueLen), y);
        renderCtx.lineWidth = 1;
        renderCtx.strokeStyle = '#ff0000';
        renderCtx.stroke();
        renderCtx.closePath();
    } else if (valueType === 'plus') {
        // Positive value
        const { plusLen } = dataBar;

        if (plusLen === 1) {
            if (format.length > 1) {
                // Gradient
                const my_gradient = renderCtx.createLinearGradient(x, y, x + w * valueLen, y);
                my_gradient.addColorStop(0, format[0]);
                my_gradient.addColorStop(1, format[1]);

                renderCtx.fillStyle = my_gradient;
            } else {
                // Solid
                [renderCtx.fillStyle] = format;
            }

            renderCtx.fillRect(x, y, w * valueLen, h);

            renderCtx.beginPath();
            renderCtx.moveTo(x, y);
            renderCtx.lineTo(x, y + h);
            renderCtx.lineTo(x + w * valueLen, y + h);
            renderCtx.lineTo(x + w * valueLen, y);
            renderCtx.lineTo(x, y);
            renderCtx.lineWidth = 1;
            [renderCtx.strokeStyle] = format;
            renderCtx.stroke();
            renderCtx.closePath();
        } else {
            const { minusLen } = dataBar;

            if (format.length > 1) {
                // Gradient
                const my_gradient = renderCtx.createLinearGradient(
                    x + w * minusLen,
                    y,
                    x + w * minusLen + w * plusLen * valueLen,
                    y,
                );
                my_gradient.addColorStop(0, format[0]);
                my_gradient.addColorStop(1, format[1]);

                renderCtx.fillStyle = my_gradient;
            } else {
                // Solid
                [renderCtx.fillStyle] = format;
            }

            renderCtx.fillRect(x + w * minusLen, y, w * plusLen * valueLen, h);

            renderCtx.beginPath();
            renderCtx.moveTo(x + w * minusLen, y);
            renderCtx.lineTo(x + w * minusLen, y + h);
            renderCtx.lineTo(x + w * minusLen + w * plusLen * valueLen, y + h);
            renderCtx.lineTo(x + w * minusLen + w * plusLen * valueLen, y);
            renderCtx.lineTo(x + w * minusLen, y);
            renderCtx.lineWidth = 1;
            [renderCtx.strokeStyle] = format;
            renderCtx.stroke();
            renderCtx.closePath();
        }
    }
}

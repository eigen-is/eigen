import type { Sheet } from '@workspace/lib/sheets';
import type { CountedWarningCode } from '../../../document/transform/protocol';
import type { StyleRegistry } from './styles';

// A sheet's conditional formats and data validations: the slot CT_Worksheet keeps for them after mergeCells.
export function rulesXml(_sheet: Sheet, _styles: StyleRegistry, _lost: (code: CountedWarningCode) => void): string {
    return '';
}

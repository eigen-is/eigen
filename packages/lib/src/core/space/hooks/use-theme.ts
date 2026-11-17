// The theme the user draws every app in, such as the one ThemeProvider puts on the page or the one the
// Preferences page and the avatar menu pick. A pick shows at once and saves to the settings in the
// background, so it follows the user to every device. This browser's copy draws it before they load.
// A browser with no copy, such as a visitor's who never signed in, follows the computer's own setting.

import { THEME_COPY_KEY } from '@workspace/lib/constants/theme';
import type { UserTheme } from '@workspace/lib/types/settings';
import { isUserTheme, themeOf } from '@workspace/lib/types/settings';
import type { SettingWithCopy } from './use-setting-with-copy';
import { useSettingWithCopy } from './use-setting-with-copy';

// Read through themeOf, so a user who never picked one is copied as Light, not drawn as a visitor.
const THEME: SettingWithCopy<UserTheme> = {
    copyKey: () => THEME_COPY_KEY,
    read: themeOf,
    patch: (theme) => ({ theme }),
    parse: (copy) => (isUserTheme(copy) ? copy : undefined),
    serialize: (theme) => theme,
};

export function useTheme(): { theme: UserTheme; setTheme: (theme: UserTheme) => void } {
    const { value, save } = useSettingWithCopy(THEME);
    const theme = value ?? 'system';
    return {
        theme,
        setTheme: (next) => {
            if (next !== theme) save(next);
        },
    };
}

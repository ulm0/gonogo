import DefaultTheme from 'vitepress/theme-without-fonts';
import '@fontsource/doto/900.css';
import '@fontsource/geist/400.css';
import '@fontsource/geist/500.css';
import '@fontsource/geist/600.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource/geist-mono/600.css';
// The app's own design system, the same files the app loads (docs/design-system.md shows them).
import '../../src/client/tokens.css';
import '../../src/client/primitives.css';
import './custom.css';

export default DefaultTheme;

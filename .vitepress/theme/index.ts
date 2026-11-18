import DefaultTheme from 'vitepress/theme-without-fonts';
import { h } from 'vue';
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
import LiverySwitch from './LiverySwitch.vue';
import PropellantMock from './landing/PropellantMock.vue';
import RoomMock from './landing/RoomMock.vue';

export default {
  extends: DefaultTheme,
  // The landing's room pieces, for a doc page to open with (docs/features/propellant.md, docs/guide/getting-started.md).
  enhanceApp: ({ app }: { app: import('vue').App }) => {
    app.component('PropellantMock', PropellantMock);
    app.component('RoomMock', RoomMock);
  },
  // The livery key: in the top bar from 768 px, in the menu screen below it.
  Layout: () => h(DefaultTheme.Layout, null, { 'nav-bar-content-after': () => h(LiverySwitch), 'nav-screen-content-after': () => h(LiverySwitch) }),
};

/* 颜色令牌最先（启动画面与应用样式都读它），再是启动画面、应用样式；然后定明暗、语言，挂载应用 */
import './styles/tokens.css';
import './boot/boot.css';
import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { startAuth } from '$lib/auth.svelte';
import { loadFonts } from '$lib/fonts';
import { startI18n } from '$lib/i18n.svelte';
import { watchPreloadErrors } from '$lib/lazy';
import { startRouter } from '$lib/router.svelte';
import { startTheme } from '$lib/theme.svelte';

startTheme();
startI18n();
startRouter();
watchPreloadErrors();
startAuth();
loadFonts();

const target = document.getElementById('app');
if (target) mount(App, { target });

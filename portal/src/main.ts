/* 颜色令牌与启动画面的样式在 index.html 的首帧样式表里（src/boot/head.css）；这里是应用样式，然后定明暗、语言，挂载应用 */
import './app.css';
import './styles/flat.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { startAuth } from '$lib/auth.svelte';
import { loadFonts } from '$lib/fonts';
import { startInputModality } from '$lib/input-modality';
import { startI18n } from '$lib/i18n.svelte';
import { preloadPage, watchPreloadErrors } from '$lib/lazy';
import { match } from '$lib/pages';
import { startIntentPrefetch } from '$lib/prefetch';
import { startRouter } from '$lib/router.svelte';
import { startTheme } from '$lib/theme.svelte';

startTheme();
startInputModality();
startI18n();
startRouter();
watchPreloadErrors();
startIntentPrefetch();
startAuth();
/* 这一页的分包与 /me 并行下载（要不要登录由 App 的门禁定；访客页本来就要这一包，仪表盘是登录后的落脚点，访客也会预载它） */
const first = match(location.pathname);
if (first) void preloadPage(first.page.load);
loadFonts();

const target = document.getElementById('app');
if (target) mount(App, { target });

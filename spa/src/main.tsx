/* 明暗最先定（src/lib/theme.ts 接手 src/boot/boot.js 在首帧前做的判断），再加载样式、挂载应用 */
import './lib/theme';
import './boot/boot.css';
import './index.css';
import { start } from './mount';

/* 启动画面何时收起由 App 决定，见 lib/boot.ts */
start();

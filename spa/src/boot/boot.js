/*
 * 启动脚本：<head> 里同步执行的经典脚本（不是模块）。
 *
 * 由 vite.config.ts 的 bootScript 插件原样输出为带哈希的 assets/boot-<hash>.js 并插进 <head>，
 * 不打进应用包——它要做的两件事都不能等应用包：
 *
 *   1. 首帧之前定下明暗。模块脚本一律延后执行，等它们跑起来深色用户已经先看到一片白。
 *      键名与判定和 src/lib/theme.ts 一致。顺便给 <html> 加 js：启动画面只在有脚本时显示
 *      （禁用 JavaScript 时它永远收不起来，还会盖住 <noscript> 的提示）。
 *   2. 启动守护。应用包（入口或它静态依赖的分包）下载失败时 React 根本跑不起来，
 *      ErrorBoundary 管不到。自动重新加载一次，还不行就在启动画面上给出提示和「重新加载」。
 *      只认本站 assets/ 下的脚本出的错：浏览器扩展、站长加的统计脚本出错不能把正常用户的页面刷掉。
 *      应用挂载之后这一段什么都不做。
 *
 * 面板的 CSP 不允许内联脚本，所以这里也不能用内联事件或 innerHTML。
 */
(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('js');

  /* ---------- 1. 明暗 ---------- */
  var THEME_KEY = 'theme';
  try {
    var mode = localStorage.getItem(THEME_KEY) || 'system';
    var dark = mode === 'dark' || (mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    root.classList.add(dark ? 'dark' : 'light');
    root.style.colorScheme = dark ? 'dark' : 'light';
  } catch { /* 隐私模式下 localStorage 会抛错：交给 CSS 的 prefers-color-scheme */ }

  /* ---------- 2. 启动守护 ---------- */
  var RETRY_KEY = 'akari.boot-retry';
  var errs = [];
  var done = false;
  /* 本脚本就在 assets/ 下：取它自己的目录，前缀（/{prefix}/assets/）自然包含在内 */
  var self = document.currentScript && document.currentScript.src;
  var base = self ? self.replace(/[^/]*$/, '') : '';

  function ours(url) { return !!base && typeof url === 'string' && url.indexOf(base) === 0; }
  function mounted() { var r = document.getElementById('root'); return !!(r && r.firstChild); }

  function show() {
    if (done || mounted()) return;
    var p = document.querySelector('#boot .slow');
    if (!p) return;
    done = true;
    p.textContent = '';
    var b = document.createElement('b');
    b.textContent = '页面加载失败';
    var s = document.createElement('span');
    s.textContent = '可能是网络不稳定，';
    var a = document.createElement('a');
    a.href = '';
    a.textContent = '重新加载';
    a.addEventListener('click', function () { try { sessionStorage.removeItem(RETRY_KEY); } catch { /* ignore */ } });
    p.appendChild(b);
    p.appendChild(s);
    p.appendChild(a);
    if (errs.length) {
      /* 错误摘要：用户截图发过来就能定位 */
      var c = document.createElement('code');
      c.textContent = errs.slice(0, 2).join(' · ');
      p.appendChild(c);
    }
    p.classList.add('failed');
  }

  function fail(msg) {
    if (mounted()) return;
    errs.push(String(msg).slice(0, 140));
    var tried = true;
    try {
      tried = sessionStorage.getItem(RETRY_KEY) === '1';
      if (!tried) sessionStorage.setItem(RETRY_KEY, '1');
    } catch { /* 存不了就别自动重试，免得无限刷新 */ }
    if (!tried) { location.reload(); return; }
    show();
  }

  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.tagName === 'SCRIPT') {
      if (ours(t.src)) fail('脚本下载失败 ' + t.src.split('/').pop());
      return;
    }
    if (!ours(e.filename)) return;
    fail((e.message || '脚本错误') + ' @' + e.filename.split('/').pop() + ':' + e.lineno);
  }, true);

  var iv = setInterval(function () {
    if (!mounted()) return;
    clearInterval(iv);
    try { sessionStorage.removeItem(RETRY_KEY); } catch { /* ignore */ }
  }, 1000);
})();

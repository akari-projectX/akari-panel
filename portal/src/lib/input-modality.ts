/**
 * 焦点环只给键盘。全站的焦点环本来就挂在 :focus-visible 上，但各浏览器的判定不一样：Safari 等对 tabindex 元素
 * （流量图 role=slider）在鼠标点击后也算 :focus-visible；在 Safari 里点按钮又不会把焦点从图上移走，于是点「7 天 / 30 天」
 * 之后图上留着一圈蓝色焦点环。这里记下最近一次输入是不是指针：指针（鼠标、触摸、笔）按下 → <html data-input="pointer">，
 * 按下任何非修饰键 → 去掉。app.css 末尾在 pointer 时去掉焦点环（文本框的聚焦边框不受影响）。
 */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

export function startInputModality() {
  const root = document.documentElement;
  addEventListener('pointerdown', () => { root.dataset.input = 'pointer'; }, { capture: true, passive: true });
  addEventListener('keydown', (e) => { if (!MODIFIERS.has(e.key)) delete root.dataset.input; }, { capture: true });
}

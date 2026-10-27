import { mount } from 'svelte';

/**
 * 提示条（components/Toaster.svelte 画出来）。手写几十行：全站只用 success / error，
 * 一个标题加一行可选的说明，3.2 秒后自动消失（指针悬停、焦点在上面时暂停），桌面在右下角、窄屏在顶部居中。
 * 首屏从来没有提示要弹：Toaster 在第一次弹提示时才下载、挂到 <body> 上（提示先进列表，挂上后照常显示）。
 */
export type Toast = { id: number; kind: 'success' | 'error'; title: string; description?: string };

export const toasts = $state<Toast[]>([]);
let next = 0;

const DURATION = 3200;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function dismiss(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const i = toasts.findIndex((x) => x.id === id);
  if (i >= 0) toasts.splice(i, 1);
}

/** 悬停 / 聚焦时停表，离开后重新计时 */
export function hold(id: number, on: boolean) {
  clearTimeout(timers.get(id));
  if (!on) timers.set(id, setTimeout(() => dismiss(id), DURATION));
}

let toaster: Promise<unknown> | null = null;

function push(kind: Toast['kind'], title: string, opts?: { description?: string }) {
  toaster ??= import('../components/Toaster.svelte').then(
    (m) => mount(m.default, { target: document.body }),
    () => { toaster = null; },
  );
  const id = ++next;
  toasts.push({ id, kind, title, description: opts?.description });
  /* 最多同时三条：最旧的先走 */
  while (toasts.length > 3) dismiss(toasts[0].id);
  hold(id, false);
}

export const toast = {
  success: (title: string, opts?: { description?: string }) => push('success', title, opts),
  error: (title: string, opts?: { description?: string }) => push('error', title, opts),
};

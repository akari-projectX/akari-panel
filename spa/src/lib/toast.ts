import type { toast as SonnerToast } from 'sonner';

/**
 * 提示条的门面。全站从这里 import toast，而不是直接从 sonner。
 *
 * sonner 压缩前 53 kB，比 App 和两个布局加起来还大；直接 import 的话它就在首屏必经的挂载分包里，
 * 可首屏从来没有提示要弹。改成：Toaster 在 App 里按需加载（和页面并行，不挡首屏），
 * 这里第一次被调用时再取 sonner，并等 Toaster 挂上之后才真正弹出——
 * sonner 的 Toaster 只接收挂载之后发出的提示，之前的会丢。
 *
 * 全站只用到 success / error，而且不用返回的 id；要用别的方法再往这里加。
 */

let mounted: () => void = () => {};
const ready = new Promise<void>((resolve) => { mounted = resolve; });

/** 由 components/ui/sonner.tsx 的 Toaster 挂载后调用。sonner 内部的订阅是子组件的 effect，先于这一步 */
export function toasterMounted() {
  mounted();
}

type Args = Parameters<typeof SonnerToast.success>;

const call = (kind: 'success' | 'error') => (...args: Args): void => {
  void Promise.all([import('sonner'), ready]).then(([m]) => { m.toast[kind](...args); });
};

export const toast = { success: call('success'), error: call('error') };

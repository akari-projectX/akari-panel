import { errorText } from './errors';
import { toast } from './toast.svelte';

/**
 * 把一个失败显示成提示条。auth.svelte.ts 按需加载这一个小模块（而不是直接 import('./errors')）：
 * errors 在好几个分包之间共享，直接动态 import 它时打包器要生成命名空间对象，那个小助手被放进了 bits-ui 的 Dialog 包，
 * 于是仪表盘等页面的静态依赖里多出整个对话框栈（约 60 KB）。
 */
export function toastError(e: unknown) {
  toast.error(errorText(e));
}

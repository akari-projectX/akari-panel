import { RotateCw } from 'lucide-react';
import Turnstile from '@/components/turnstile';
import type { FormGuardState } from '@/lib/form-guard';
import { useT } from '@/i18n';

/**
 * 公开表单里的防护字段：
 *   · 蜜罐：一个叫 website 的输入框，人看不见、读屏跳过、浏览器不自动填；机器人填了就会被面板按普通失败拒掉；
 *   · Turnstile：站长为这张表单开了才出现；加载失败（脚本被拦、组件出错、交互超时）时显示原因和「重试」。
 */
export default function GuardFields({ guard }: { guard: FormGuardState }) {
  const tr = useT();
  return (
    <>
      {guard.honeypot && (
        <div aria-hidden className="pointer-events-none absolute -left-[9999px] h-px w-px overflow-hidden">
          <label>
            Website
            <input
              type="text" name="website" tabIndex={-1} autoComplete="off"
              value={guard.website} onChange={(e) => guard.setWebsite(e.target.value)}
            />
          </label>
        </div>
      )}
      {guard.siteKey && (
        <div className="space-y-1.5">
          <Turnstile
            siteKey={guard.siteKey} resetKey={guard.resetKey}
            onToken={guard.onToken} onError={guard.setFailed}
          />
          {guard.failed && (
            <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-destructive">
              <span>{tr('人机验证加载失败，请刷新重试')}</span>
              <button type="button" onClick={guard.retry} className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline">
                <RotateCw className="size-3.5" />{tr('重试')}
              </button>
            </div>
          )}
        </div>
      )}
      {guard.unavailable && (
        <p className="rounded-xl bg-muted/60 px-4 py-3 text-[12.5px] leading-[1.8] text-muted-foreground">
          {tr('站点设置暂时读不出来，请稍后刷新再试。')}
        </p>
      )}
    </>
  );
}

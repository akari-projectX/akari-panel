import { useState } from 'react';
import { useT, useTp } from '@/i18n';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { meApi } from '@/api';
import { usePending } from '@/hooks/use-api';
import { useAuth } from '@/lib/auth';
import { useErrorText } from '@/lib/errors';
import { ConfirmDialog } from '@/components/ui/panels';

/**
 * 重置订阅（危险操作，二次确认）。仪表盘与设置页共用。
 * 面板一次做三件事（高-3）：换新链接、轮换所有入口上的凭据、断开现有连接——所有设备立即断线。每小时最多 5 次。
 * 确认按钮等请求完成才关弹窗：「重置中」看得见，失败的原因留在弹窗里。
 * look：link = 区块头上的文字按钮（仪表盘），button = 设置行里的描边按钮。
 */
export default function ResetSubscription({ look = 'link' }: { look?: 'link' | 'button' }) {
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const { refresh } = useAuth();
  const [pending, run] = usePending();
  const [error, setError] = useState<string | null>(null);

  const reset = () => run(async () => {
    setError(null);
    try {
      const r = await meApi.resetSubscription();
      await refresh();
      toast.success(tr('订阅已重置'), {
        description: tp('已轮换 {n} 个入口的凭据，请在所有设备上重新导入订阅', { n: r.credentials_rotated }),
      });
    } catch (e) {
      setError(errText(e));
      throw e;
    }
  });

  return (
    <ConfirmDialog
      trigger={look === 'link' ? (
        <Button variant="link" size="sm" className="text-warning hover:text-warning">
          <RefreshCw />{tr('重置订阅')}
        </Button>
      ) : (
        <Button variant="outline" className="h-9 text-warning hover:text-warning">
          <RefreshCw />{tr('重置')}
        </Button>
      )}
      tone="warning"
      icon={<TriangleAlert />}
      title={tr('重置订阅？')}
      description={tr('链接泄露时重置。所有设备都会断开，需要重新导入。')}
      consequences={[
        tr('旧的订阅链接立即失效'),
        tr('所有设备会立即断线，节点上的旧凭据同时作废'),
        tr('所有设备都要重新导入订阅'),
        tr('此操作不可撤销'),
      ]}
      confirmLabel={pending ? tr('重置中') : tr('确认重置')}
      pending={pending}
      error={error}
      onConfirm={reset}
    />
  );
}

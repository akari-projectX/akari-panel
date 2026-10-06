import { useId } from 'react';
import { CreditCard, QrCode, Wallet, type LucideIcon } from 'lucide-react';
import type { PayMethod } from '@/api';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n';

/** 面板的 icon 是后台填的短名字（a-z 0-9 - _），不是图片地址：认得的换成对应图标 */
const ICONS: Record<string, LucideIcon> = { alipay: QrCode, wechat: QrCode, balance: Wallet };

/** 支付方式（面板 /me/shop 的 methods，后台排好的顺序）。多于一种时下单必须选（order.method_required） */
export default function PaymentMethodPicker({
  methods, value, onValueChange,
}: {
  methods: PayMethod[];
  value: string | null;
  onValueChange: (id: string) => void;
}) {
  const tr = useT();
  const groupId = useId();

  return (
    <fieldset>
      <legend className="sr-only">{tr('支付方式')}</legend>
      <div className="grid grid-cols-2 gap-2">
        {methods.map((method) => {
          const selected = value === method.id;
          const id = `${groupId}-${method.id}`;
          const Icon = ICONS[method.icon ?? method.kind] ?? CreditCard;
          return (
            <div key={method.id} className="relative">
              <input
                id={id} type="radio" name={groupId} value={method.id} checked={selected}
                onChange={() => onValueChange(method.id)} className="peer sr-only"
              />
              <label
                htmlFor={id}
                className={cn(
                  'flex h-full cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2',
                  selected ? 'border-brand bg-brand/5' : 'border-border hover:bg-muted/50',
                )}
              >
                <Icon aria-hidden className={cn('size-4 shrink-0', selected ? 'text-brand' : 'text-muted-foreground')} />
                <span className={cn('block min-w-0 truncate text-[13px] font-medium', selected && 'text-brand')}>
                  {method.display_name}
                </span>
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

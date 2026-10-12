import { useId, useState, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * 全站的文本输入字段：标签 + 输入框 + 常驻帮助文字 / 内联错误（二选一，同一个位置）。
 *
 * 校验不用浏览器原生气泡（`required`、`type=email` 那一套：语言跟浏览器走、样式与站点不搭、手机上位置不定）：
 * 表单写 `noValidate`，提交时用 lib/form-errors 算出每个字段的错误，这里把它画在输入框下方，
 * 输入框红边 + `aria-invalid` + `aria-describedby` 指向这行字，读屏能读到；第一个出错的字段被聚焦。
 * 服务端答复里能对应到某个字段的错误码（当前密码错误、验证码错误……）也画在这里，其余的才用 toast。
 *
 * 密码框自带「显示 / 隐藏」按钮。
 */
export default function TextField({
  label, hint, help, error, large = false, type = 'text', className, id: givenId, ...rest
}: React.ComponentProps<typeof Input> & {
  label: ReactNode;
  /** 标签行右侧：「忘记密码」之类 */
  hint?: ReactNode;
  /** 常驻帮助文字（如「至少 8 位」）；有错误时被错误替换 */
  help?: ReactNode;
  error?: string;
  /** 登录注册页的大号（44px、大圆角）；默认是设置与弹窗里的 40px */
  large?: boolean;
}) {
  const tr = useT();
  const auto = useId();
  const id = givenId ?? auto;
  const msg = `${id}-msg`;
  const [show, setShow] = useState(false);
  const isPwd = type === 'password';
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id} className="text-[13px] font-medium">{label}</Label>
        {hint}
      </div>
      <div className="relative">
        <Input
          {...rest}
          id={id}
          type={isPwd && show ? 'text' : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || help ? msg : undefined}
          className={cn(
            large ? 'h-11 rounded-xl text-[15px] shadow-none' : 'h-10',
            isPwd && 'pr-10',
            className,
          )}
        />
        {isPwd && (
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-controls={id}
            aria-label={show ? tr('隐藏密码') : tr('显示密码')}
            className="absolute top-1/2 right-3 -translate-y-1/2 text-faint transition-colors hover:text-foreground"
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        )}
      </div>
      {(error || help) && (
        <p
          id={msg}
          role={error ? 'alert' : undefined}
          className={cn('text-[12.5px] leading-[1.6]', error ? 'state-in text-danger' : 'text-muted-foreground')}
        >
          {error || help}
        </p>
      )}
    </div>
  );
}

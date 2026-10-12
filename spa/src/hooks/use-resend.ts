import { useEffect, useState } from 'react';

/** 重发验证码前要等的秒数（验证当前邮箱、更换邮箱一致；面板另有按地址的发信限速） */
const RESEND_SECS = 60;

/** 重发倒计时：start() 开始，left 是剩余秒数 */
export function useResend() {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return { left, start: () => setLeft(RESEND_SECS) };
}

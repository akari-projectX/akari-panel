/**
 * 法务页里的邮箱。地址来自主题配置（站长手填），长得像邮箱才做成 mailto 链接，否则原样当文字显示。
 */
const LOOKS_LIKE_EMAIL = /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[^\s@<>"'()]+$/;

export default function MailLink({ email }: { email: string }) {
  if (!LOOKS_LIKE_EMAIL.test(email)) return <>{email}</>;
  return (
    <a href={`mailto:${email}`} className="text-brand underline-offset-4 hover:underline">
      {email}
    </a>
  );
}

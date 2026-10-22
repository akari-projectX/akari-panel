/**
 * 新通行密钥的默认名字：按这台设备认个大概（"iPhone · Safari"），用户之后可以改名。
 * 面板限 1–64 个字符、不含控制字符。
 */
export function defaultPasskeyName(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : '';
  const name = [os, browser].filter(Boolean).join(' · ');
  return name || 'Passkey';
}

/**
 * 仪表盘「使用文档」卡片、订阅区「下载客户端」用的平台清单。
 * id 与面板 branding.client_downloads 的 platform 一致（windows/macos/linux/android/ios/harmony；路由器面板没有下载项）。
 *
 * 教程正文在知识库里，由站长维护；这里只留卡片上要画的东西：
 * 平台名、图标、常见客户端。
 *
 * keywords 用来把平台对到知识库的**分类名**上（站长起的，没有固定写法），
 * 小写后做包含匹配；对不上分类时退一步去匹配文章标题，再对不上就带着平台名去搜索。
 */
export type Platform = {
  id: string;
  name: string;
  icon: string;
  client: string;
  keywords: string[];
};

export const PLATFORMS: Platform[] = [
  {
    id: 'windows', name: 'Windows', icon: 'windows', client: 'Clash Verge Rev',
    keywords: ['windows', 'win10', 'win11', 'win 10', 'win 11', '电脑'],
  },
  {
    id: 'macos', name: 'macOS', icon: 'apple', client: 'Clash Verge Rev',
    keywords: ['macos', 'mac os', 'mac', 'osx', '苹果电脑'],
  },
  {
    id: 'ios', name: 'iOS', icon: 'apple', client: 'Shadowrocket',
    keywords: ['ios', 'iphone', 'ipad', '苹果手机', 'shadowrocket', '小火箭'],
  },
  {
    id: 'android', name: 'Android', icon: 'android', client: 'Clash Meta for Android',
    keywords: ['android', '安卓'],
  },
  {
    id: 'linux', name: 'Linux', icon: 'linux', client: 'sing-box / mihomo',
    keywords: ['linux', 'ubuntu', 'debian', 'centos'],
  },
  {
    id: 'harmony', name: 'HarmonyOS', icon: 'android', client: 'Clash Meta for Android',
    keywords: ['harmony', '鸿蒙'],
  },
  {
    id: 'router', name: '路由器', icon: 'router', client: 'OpenWrt / 梅林固件',
    keywords: ['路由', 'router', 'openwrt', '梅林', 'merlin'],
  },
];

/** 粗略识别当前系统，用于在「使用文档」里直接主推这台设备的教程 */
export function detectPlatform(): Platform {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const id = /iPhone|iPad|iPod/i.test(ua) ? 'ios'
    : /Android/i.test(ua) ? 'android'
    : /Macintosh|Mac OS X/i.test(ua) ? 'macos'
    : /Windows/i.test(ua) ? 'windows'
    : /Linux/i.test(ua) ? 'linux'
    : 'windows';
  return PLATFORMS.find((p) => p.id === id) ?? PLATFORMS[0];
}

import { type MyNode } from '@/api';

/**
 * 节点 → 国旗。
 *
 * 面板给的 region 是站长随手填的（「香港」「HK」「Tokyo」都有），节点名里也常带地区信息：
 * 要么直接是 🇭🇰 这样的旗帜 emoji，要么是「香港」「Tokyo」这类地名。
 * 两条路都试一遍，都认不出就不显示旗帜——猜错国旗比不显示更糟。
 */

/** 旗帜 emoji 由两个「区域指示符号」组成，码位减去偏移就是 ISO 国家码 */
function ccFromEmoji(name: string): string | null {
  const m = [...name].filter((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return c >= 0x1f1e6 && c <= 0x1f1ff;
  });
  if (m.length < 2) return null;
  const letters = m.slice(0, 2).map((ch) => String.fromCharCode((ch.codePointAt(0)! - 0x1f1e6) + 65));
  return letters.join('');
}

/** 常见地区的中英文写法。命中即返回，顺序上把易混的放前面（「中国香港」要先于「中国」） */
const KEYWORDS: [string[], string][] = [
  [['香港', 'hong kong', 'hongkong', 'hk'], 'HK'],
  [['澳门', '澳門', 'macao', 'macau'], 'MO'],
  [['台湾', '台灣', '台北', 'taiwan', 'taipei', 'tw'], 'TW'],
  [['日本', '东京', '東京', '大阪', 'japan', 'tokyo', 'osaka', 'jp'], 'JP'],
  [['韩国', '韓國', '首尔', '首爾', 'korea', 'seoul', 'kr'], 'KR'],
  [['新加坡', 'singapore', 'sg'], 'SG'],
  [['美国', '美國', '洛杉矶', '洛杉磯', '硅谷', '圣何塞', 'united states', 'america', 'usa', 'los angeles', 'san jose', 'seattle', 'us'], 'US'],
  [['英国', '英國', '伦敦', '倫敦', 'united kingdom', 'britain', 'london', 'uk', 'gb'], 'GB'],
  [['德国', '德國', '法兰克福', '法蘭克福', 'germany', 'frankfurt', 'de'], 'DE'],
  [['法国', '法國', '巴黎', 'france', 'paris', 'fr'], 'FR'],
  [['荷兰', '荷蘭', '阿姆斯特丹', 'netherlands', 'amsterdam', 'nl'], 'NL'],
  [['俄罗斯', '俄羅斯', '莫斯科', 'russia', 'moscow', 'ru'], 'RU'],
  [['加拿大', 'canada', 'ca'], 'CA'],
  [['澳大利亚', '澳洲', '悉尼', 'australia', 'sydney', 'au'], 'AU'],
  [['印度', 'india', 'mumbai', 'in'], 'IN'],
  [['土耳其', 'turkey', 'türkiye', 'tr'], 'TR'],
  [['越南', 'vietnam', 'vn'], 'VN'],
  [['泰国', '泰國', 'thailand', 'th'], 'TH'],
  [['马来西亚', '馬來西亞', 'malaysia', 'my'], 'MY'],
  [['菲律宾', '菲律賓', 'philippines', 'ph'], 'PH'],
  [['印尼', 'indonesia', 'id'], 'ID'],
  [['巴西', 'brazil', 'br'], 'BR'],
  [['阿根廷', 'argentina', 'ar'], 'AR'],
  [['南非', 'south africa', 'za'], 'ZA'],
  [['中国', '中國', '国内', '國內', 'china', 'cn'], 'CN'],
];

export function guessCC(name: string): string | null {
  const fromEmoji = ccFromEmoji(name);
  if (fromEmoji) return fromEmoji;
  const lower = name.toLowerCase();
  for (const [keys, cc] of KEYWORDS) {
    if (keys.some((k) => lower.includes(k))) return cc;
  }
  return null;
}

/** 去掉名字里的旗帜 emoji，避免和旁边那面旗重复 */
export function stripFlag(name: string): string {
  return name.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '').trim();
}

/** 倍率越低越划算，配色跟着这个语义走 */
export function rateTone(rate: number): string {
  if (rate <= 0.5) return 'bg-emerald-500/12 text-success';
  if (rate > 1) return 'bg-amber-500/12 text-warning';
  return 'bg-brand/10 text-brand-ink';
}

/**
 * 线路等级。站长在节点标签里填这几个词，就按这个顺序排在最前，其它自定义标签保持原来的先后。
 * 比较时忽略大小写和空格（「cn2gia」「CN2 GIA」算同一个）。
 */
const TIERS = ['CN2 GIA', 'AS9929', 'CMIN2', '标准'];
const norm = (t: string) => t.replace(/\s+/g, '').toUpperCase();
const rank = (t: string) => {
  const i = TIERS.findIndex((k) => norm(k) === norm(t));
  return i < 0 ? TIERS.length : i;
};

/** 按线路等级排好的标签；稳定排序，同级的保持站长填写的顺序 */
export function sortTags(tags: string[] | null | undefined): string[] {
  return (tags ?? [])
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map((x) => x.t);
}

/* ───────────── /me/nodes 的一行 ───────────── */


/** 一行的稳定键：节点名 + 入口名（面板不给 id） */
export const nodeKey = (n: Pick<MyNode, 'name' | 'entrance'>) => `${n.name}\u0000${n.entrance}`;

/** 国旗：先认面板的 region，认不出再从节点名里猜 */
export function nodeCC(n: Pick<MyNode, 'name' | 'region'>): string | null {
  return (n.region ? guessCC(n.region) : null) ?? guessCC(n.name);
}

/**
 * 能连：只看状态。维护中（中转入口健康检查失败、服务器流量额度用完）与离线的都列出来但置灰，
 * 订阅里没有维护中的线路。倍率是面板给的此刻倍率（D9，`n.rate`）。
 */
export const nodeUp = (n: Pick<MyNode, 'status'>) => n.status === 'online';

/** 延迟参考：优先面板到入口的 TCP 测速，没有再用节点自己的测速 */
export const nodeLatency = (n: Pick<MyNode, 'probe_ms' | 'latency_ms'>) => n.probe_ms ?? n.latency_ms;

/** 状态与负载的文案（tr 的键） */
export const STATUS_TEXT = { online: '在线', offline: '离线', maintenance: '维护中' } as const;
export const LOAD_TEXT = { low: '负载低', medium: '负载中', high: '负载高' } as const;

/** 线路状态多久重新取一次 */
export const NODES_REFRESH_MS = 30_000;

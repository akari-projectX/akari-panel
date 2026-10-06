import { PORTAL_MODE } from './base';

/**
 * 依赖面板**尚未合并**的功能的开关（W36-b PR2 随面板 ②/③ 合并后打开，见 README「待合并的面板功能」）。
 *
 * 构建时由 VITE_PANEL_FEATURES 打开，逗号分隔，例如 `VITE_PANEL_FEATURES=rates,self-delete`。
 * 关着时页面完全按面板 main 现有的接口工作；开着时才去用 ./planned 里按计划形状写的接口和字段。
 *
 *   rates          ② W28-b D9：入口的当前倍率与时段规则（/me/nodes 的 rate_now、rate_rules）
 *   server-quota   ② W28-b D5：服务器流量额度用完时入口暂停（/me/nodes 的 suspended）
 *   sub-clients    ② W30：一键导入的客户端清单由面板给（GET /me/sub-clients）
 *   self-delete    ③ W27：自助注销（GET /me/delete-impact、POST /me/delete）
 *   sub-url-only   ③ W27-4/D8：订阅地址只用面板给的 sub_url（随机订阅路径、订阅域名），不再用令牌自己拼
 */

export type Feature = 'rates' | 'server-quota' | 'sub-clients' | 'self-delete' | 'sub-url-only';

const ALL: Feature[] = ['rates', 'server-quota', 'sub-clients', 'self-delete', 'sub-url-only'];

export function parseFeatures(raw: string | undefined): Set<Feature> {
  const set = new Set<Feature>();
  for (const part of (raw ?? '').split(',')) {
    const f = part.trim() as Feature;
    if (ALL.includes(f)) set.add(f);
  }
  return set;
}

const enabled = parseFeatures(import.meta.env.VITE_PANEL_FEATURES);
/* 门户在根路径部署（③）时订阅路径已经是随机的，令牌拼出来的 /sub/ 地址不存在 */
if (PORTAL_MODE === 'root') enabled.add('sub-url-only');

export function feature(f: Feature): boolean {
  return enabled.has(f);
}

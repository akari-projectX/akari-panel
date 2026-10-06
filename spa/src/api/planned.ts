/**
 * 面板**尚未合并**的接口，按计划的形状写在这里（W36-b PR2 随 ②/③ 合并时核对、必要时改这一个文件）。
 * 每个函数都只在对应的开关（./features）打开时才会被页面调用。
 */

import { api } from './http';
import type { DeleteImpact } from './types';

/** sub-clients（② W30）：一键导入的客户端清单，深链接由面板按 W30 定稿的 scheme 生成 */
export type SubClient = { id: string; name: string; platforms: string[]; href: string };

export const plannedApi = {
  subClients: () => api.get<{ clients: SubClient[] }>('/me/sub-clients'),

  /** self-delete（③ W27）：注销会丢掉什么（形状照后台的 GET /users/{id}/delete-impact） */
  deleteImpact: () => api.get<DeleteImpact>('/me/delete-impact'),

  /** self-delete（③ W27）：删除个人数据，财务记录匿名化保留；没有密码的账户不传 password */
  deleteAccount: (password: string | undefined) =>
    api.post<void>('/me/delete', { confirm: true, ...(password ? { password } : {}) }),
};

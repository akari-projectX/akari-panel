/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 门户部署位置：root（默认，主域名根路径）或 prefixed（过渡期，面板秘密前缀下的 /app），见 src/api/base.ts */
  readonly VITE_PORTAL_MODE?: 'root' | 'prefixed';
  /** 打开依赖面板未合并功能的开关，逗号分隔，见 src/api/features.ts */
  readonly VITE_PANEL_FEATURES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

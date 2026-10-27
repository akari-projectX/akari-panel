// 系统设置的读取：各接口的类型与查询（查询键以 "settings" 开头，任何
// /settings 写入都会让它们重新获取，data.ts）。`fresh` 在保存时取最新的
// 值：同一行设置（panel_settings）的几个接口共用一个 version，一个分区依次
// 保存两块时第二块要用第一块保存后的 version。
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { get } from "../../shared/api";

export type DomainEntry = { domain: string; display: string; preferred: boolean };
export type SettingsView = {
  version: number;
  main: { domains: DomainEntry[]; effective: string | null };
  sub: { domains: DomainEntry[]; effective: string | null };
  node: { domains: DomainEntry[]; panel_addr: string | null; server_name: string | null; default_port: number };
  sub_domain_per_user: boolean;
  trust_cloudflare: { value: boolean | null; effective: boolean };
  server_names: {
    name: string;
    display: string;
    source: string;
    first_used_at: string;
    current: boolean;
    locked: string | null;
    nodes: { id: string; name: string; reason: string }[];
  }[];
  certificate_names: string[];
  host_gate: boolean;
  site_name: string | null;
  timezone: { value: string | null; effective: string; default: string };
  passkey: {
    domain: string | null;
    rp_id: string | null;
    related_origins: string[];
    labels: number;
    label_limit: number;
  };
  obsolete_config_keys: string[];
  warnings: string[];
  probe: {
    interval_secs: { value: number | null; effective: number; default: number };
    urls: { value: string[] | null; effective: string[]; default: string[] };
    panel_tcp: { value: boolean | null; effective: boolean; default: boolean };
    manual_cooldown_secs: number;
  };
  node_ops: {
    install_tls_pin: string | null;
    install_fallback_url: string | null;
    install_fallback_effective: string | null;
    install_fallback_default: string;
    acme_directory_url: string | null;
    acme_email: string | null;
    remove_mode: { value: string | null; effective: string };
  };
  security: {
    audit_retention_days: { value: number | null; effective: number; default: number };
    traffic_daily_retention_days: { value: number | null; effective: number; default: number };
    cloudflare_ranges: string[] | null;
    cloudflare_ranges_shipped: number;
    extra_release_keys: string[] | null;
    release_keys: { id: string; label: string; official: boolean }[];
  };
  subscription: {
    formats: { value: string[] | null; effective: string[] };
    import_clients: { value: string[] | null; effective: string[] };
    /** Line names carry the entrance's base multiplier (default off). */
    name_rate: boolean;
    /**
     * 仅自研客户端 (default off): the subscription answers only the Akari
     * client, the portal shows no link; `formats` / `import_clients` stay as
     * stored (restored when the mode is turned off).
     */
    own_client_only: boolean;
  };
};

export function useSettings(enabled = true) {
  return useQuery({ queryKey: ["settings"], queryFn: () => get<SettingsView>("/settings"), enabled });
}

export type Access = {
  version: number;
  admin_prefix: string;
  admin_url: string | null;
  admin_allow_cidrs: string[];
  your_ip: string | null;
  sub_path: string;
};

export function useAccess(enabled = true) {
  return useQuery({ queryKey: ["settings", "access"], queryFn: () => get<Access>("/settings/access"), enabled });
}

export type AuthSettings = {
  version: number;
  turnstile_site_key: string | null;
  turnstile_secret_set: boolean;
  turnstile_login: boolean;
  turnstile_register: boolean;
  turnstile_reset: boolean;
  honeypot: boolean;
  min_submit_secs: number;
  passkey_only_admins: boolean;
  passkey_only_users: boolean;
  passkey_prompt: boolean;
  warnings: string[];
};

export function useAuthSettings(enabled = true) {
  return useQuery({ queryKey: ["settings", "auth"], queryFn: () => get<AuthSettings>("/settings/auth"), enabled });
}

/** The latest cached value of a query (after a save's refetch landed). */
export function fresh<T>(qc: QueryClient, key: readonly unknown[], fallback: T): T {
  return qc.getQueryData<T>(key) ?? fallback;
}

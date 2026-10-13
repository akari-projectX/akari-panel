// USDT on-chain (C2) bits shared by 系统设置 → 支付方式 (the usdt_chain
// form and its 测试连接 result) and 资金 → 链上收款 (the transfers):
// the networks the panel supports (mirror of billing::chain::CHAINS),
// their official USDT contracts (docs/PAYMENTS.md) and block explorers.
import { ExternalLink } from "lucide-react";
import { useTr, type Tr } from "../../shared/i18n";
import { Callout, KV } from "../../shared/ui/layout";

export type ChainId = "polygon" | "plasma";

export const CHAINS: Record<
  ChainId,
  { name: string; chainId: number; usdt: string; confirmations: number; explorer: string }
> = {
  polygon: {
    name: "Polygon PoS",
    chainId: 137,
    usdt: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    confirmations: 32,
    explorer: "https://polygonscan.com",
  },
  plasma: {
    name: "Plasma",
    chainId: 9745,
    usdt: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb",
    confirmations: 10,
    explorer: "https://plasmascan.to",
  },
};

export function chainOf(id: string | null | undefined) {
  return id && id in CHAINS ? CHAINS[id as ChainId] : null;
}

export function networkName(id: string | null | undefined): string {
  return chainOf(id)?.name ?? id ?? "—";
}

/** USDT base units (6 decimals) as text. */
export function usdt(units: number): string {
  const neg = units < 0;
  const u = Math.abs(units);
  return `${neg ? "−" : ""}${Math.floor(u / 1_000_000)}.${String(u % 1_000_000).padStart(6, "0")}`;
}

/** A transaction on the network's explorer (opens in a new tab). */
export function TxLink({ chain, hash, label }: { chain: string; hash: string; label?: string }) {
  const tr = useTr();
  const c = chainOf(chain);
  if (!c) return null;
  return (
    <a
      href={`${c.explorer}/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-primary hover:underline"
      aria-label={tr(`在 ${c.name} 浏览器中查看交易`, `View the transaction on the ${c.name} explorer`)}
    >
      {label ?? tr("浏览器", "Explorer")}
      <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  );
}

/** The answer of `POST /settings/payments/{id}/test`. */
export type TestResult = {
  ok: boolean;
  result: string;
  message: string;
  sub_code?: string | null;
  details?: {
    expected_chain_id?: number;
    chain_id?: number | null;
    head?: number | null;
    decimals?: number | null;
  };
};

function verdict(result: string, tr: Tr): string {
  switch (result) {
    case "rpc_ok":
      return tr("连接正常", "Connection works");
    case "chain_mismatch":
      return tr("RPC 端点属于另一条链", "The RPC endpoint is on another chain");
    case "token_invalid":
      return tr("代币合约不是 6 位小数的 USDT", "The token contract is not a 6-decimal USDT");
    default:
      return tr("RPC 端点不可用", "The RPC endpoint is not reachable");
  }
}

/** One line for a toast (the list's 测试 button). */
export function chainTestSummary(r: TestResult, tr: Tr): string {
  const d = r.details ?? {};
  const parts = [verdict(r.result, tr)];
  if (d.chain_id != null) parts.push(tr(`链 ID ${d.chain_id}`, `chain id ${d.chain_id}`));
  if (d.head != null) parts.push(tr(`最新区块 ${d.head.toLocaleString()}`, `head ${d.head.toLocaleString()}`));
  if (d.decimals != null) parts.push(tr(`${d.decimals} 位小数`, `${d.decimals} decimals`));
  return parts.join(" · ");
}

/** The 测试连接 result inside the method dialog: what was read, and the server's explanation. */
export function ChainTestResult({ r }: { r: TestResult }) {
  const tr = useTr();
  const d = r.details ?? {};
  const dash = "—";
  const idOk = d.chain_id != null && d.chain_id === d.expected_chain_id;
  return (
    <Callout
      tone={r.ok ? "success" : "danger"}
      title={`${tr("测试连接：", "Test: ")}${verdict(r.result, tr)}`}
      className="grid"
    >
      <div data-testid="chain-test-result" className="mt-2 grid gap-2">
        <KV
          cols={3}
          items={[
            {
              k: tr("链 ID", "Chain id"),
              v: (
                <span className={d.chain_id != null && !idOk ? "text-destructive" : undefined}>
                  {d.chain_id ?? dash}
                  {d.expected_chain_id != null && !idOk
                    ? tr(`（应为 ${d.expected_chain_id}）`, ` (expected ${d.expected_chain_id})`)
                    : ""}
                </span>
              ),
              mono: true,
            },
            { k: tr("最新区块", "Head"), v: d.head != null ? d.head.toLocaleString() : dash, mono: true },
            {
              k: tr("代币小数位", "Token decimals"),
              v: (
                <span className={d.decimals != null && d.decimals !== 6 ? "text-destructive" : undefined}>
                  {d.decimals ?? dash}
                </span>
              ),
              mono: true,
            },
          ]}
        />
        {!r.ok && <p className="text-footnote break-words text-muted-foreground">{r.message}</p>}
      </div>
    </Callout>
  );
}

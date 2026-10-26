<script lang="ts">
  /* 页签（v1.4.0 ui/tabs 的默认变体）：role=tablist / tab，aria-selected；←→ Home End 切换（WAI-ARIA tabs）。id = 给每个标签 tab-<key>，面板用 aria-controls */
  let { tabs, value, onchange, label, mb = false, inline = false, px3 = false, mb7 = false, idPrefix = 'tab' }: {
    tabs: { key: string; label: string }[]; value: string; onchange: (key: string) => void; label?: string; mb?: boolean; inline?: boolean; px3?: boolean; mb7?: boolean; idPrefix?: string;
  } = $props();

  function key(e: KeyboardEvent, i: number) {
    const n = tabs.length;
    const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const list = e.currentTarget as HTMLElement;
    onchange(tabs[next].key);
    queueMicrotask(() => list.parentElement?.querySelector<HTMLElement>(`[data-k="${tabs[next].key}"]`)?.focus());
  }
</script>

<div class={['tabs-pill', inline && 'inl', mb && 'mb', px3 && 'px3', mb7 && 'mb7']} role="tablist" aria-label={label}>
  {#each tabs as x, i (x.key)}
    <button type="button" role="tab" id="{idPrefix}-{x.key}" aria-controls="panel-{x.key}" data-k={x.key} aria-selected={value === x.key} tabindex={value === x.key ? 0 : -1} onclick={() => onchange(x.key)} onkeydown={(e) => key(e, i)}>{x.label}</button>
  {/each}
</div>

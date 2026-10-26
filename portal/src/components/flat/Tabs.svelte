<script lang="ts">
  /* 页签（v1.4.0 ui/tabs 的默认变体）：role=tablist / tab，aria-selected；←→ 切换 */
  let { tabs, value, onchange, label, mb = false }: { tabs: { key: string; label: string }[]; value: string; onchange: (key: string) => void; label?: string; mb?: boolean } = $props();

  function key(e: KeyboardEvent, i: number) {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = tabs[(i + d + tabs.length) % tabs.length];
    onchange(next.key);
    queueMicrotask(() => (e.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(`[data-k="${next.key}"]`)?.focus());
  }
</script>

<div class={['tabs-pill', mb && 'mb']} role="tablist" aria-label={label}>
  {#each tabs as x, i (x.key)}
    <button type="button" role="tab" data-k={x.key} aria-selected={value === x.key} tabindex={value === x.key ? 0 : -1} onclick={() => onchange(x.key)} onkeydown={(e) => key(e, i)}>{x.label}</button>
  {/each}
</div>

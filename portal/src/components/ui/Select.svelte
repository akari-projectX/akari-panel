<script lang="ts">
  import { Select } from 'bits-ui';
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';

  /*
   * 下拉选择（v1.4.0 shadcn Select 的外观，bits-ui Select：键盘 ↑↓ Home End、输入首字母跳转、Esc 关闭并还焦点、读屏 listbox）。
   * 触发按钮像输入框（40px 高，右侧小箭头），选项浮层是圆角卡片 + 1px 环，选中项右侧打勾。
   */
  let { value = $bindable(''), items, id, 'aria-describedby': describedby, onchange }: {
    value?: string;
    items: { value: string; label: string }[];
    id?: string;
    'aria-describedby'?: string;
    onchange?: (v: string) => void;
  } = $props();

  const current = $derived(items.find((i) => i.value === value));
</script>

<Select.Root type="single" bind:value {items} onValueChange={(v) => onchange?.(v)}>
  <Select.Trigger {id} class="input sel-trig" aria-describedby={describedby}>
    <span class="sel-val">{current?.label ?? ''}</span>
    <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content class="sel-pop" sideOffset={4} align="start">
      <Select.Viewport class="sel-vp">
        {#each items as it (it.value)}
          <Select.Item value={it.value} label={it.label} class="sel-item">
            {#snippet children({ selected })}
              <span>{it.label}</span>
              {#if selected}<Check class="sel-ck" size={16} strokeWidth={1.75} aria-hidden="true" />{/if}
            {/snippet}
          </Select.Item>
        {/each}
      </Select.Viewport>
    </Select.Content>
  </Select.Portal>
</Select.Root>

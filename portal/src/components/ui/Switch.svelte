<script lang="ts">
  import { Switch } from 'bits-ui';

  /* 开关（bits-ui Switch：role=switch、aria-checked、空格 / 回车切换）；样稿 .switch：36×20，开 = 品牌蓝 */
  let { checked = $bindable(false), id, disabled = false, label }: {
    checked?: boolean;
    id?: string;
    disabled?: boolean;
    /** 没有可见的 <label for> 时的读屏名称 */
    label?: string;
  } = $props();
</script>

<Switch.Root bind:checked {id} {disabled} class="switch" aria-label={label}>
  <Switch.Thumb class="switch-thumb" />
</Switch.Root>

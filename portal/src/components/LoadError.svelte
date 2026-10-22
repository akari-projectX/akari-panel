<script lang="ts">
  import { errorText } from '$lib/errors';
  import { t } from '$lib/i18n.svelte';

  /* 一块内容没取到：一句话原因（lib/errors）+ 「重试」 */
  let { error, onretry }: { error: unknown; onretry: () => void } = $props();
</script>

<div class="load-error" role="alert">
  <p>{errorText(error)}</p>
  <button type="button" class="btn sm" onclick={onretry}>{t('重试')}</button>
</div>

<script lang="ts">
  import AuthShell from '../components/auth/AuthShell.svelte';
  import AuthTitle from '../components/auth/AuthTitle.svelte';
  import { t } from '$lib/i18n.svelte';
  import { R } from '$lib/routes';

  /*
   * 注销之后的结果页（公开：会话已被面板清掉；与 React 门户 pages/auth.tsx 的 AccountDeleted 相同）。
   * 注销那一步把「是否匿名化保留」放在 history.state 里（navigate(R.deleted, { state: { anonymized } })）；刷新后没了，就只说账户已注销。
   */
  const anonymized = (history.state as { anonymized?: boolean } | null)?.anonymized;
</script>

<AuthShell>
  <AuthTitle
    title={t('账户已注销')}
    lead={anonymized === true
      ? t('你的个人数据已删除；付款与退款记录按法规匿名保留，不再与你关联。')
      : anonymized === false
        ? t('你的账户和个人数据已全部删除。')
        : t('你的账户已注销，所有设备上的登录都已结束。')}
  />
  <p class="au-note">{t('这个邮箱以后可以重新注册，但原来的套餐、余额和记录不会回来。')}</p>
  <a class="btn pri btn-block btn-gap" href={R.login} data-replace>{t('返回登录页')}</a>
</AuthShell>

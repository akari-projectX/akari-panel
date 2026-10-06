import { Component, type ReactNode } from 'react';
import ErrorScreen, { type ErrorKind } from '@/components/error-screen';

/**
 * 分包下载失败和真正的渲染崩溃，用户看到的应该是两句不同的话：
 * 前者刷新就好（多半是网断了，或我们刚发过版），后者是我们写错了。
 * 报错信息各浏览器措辞不同，这里按几个稳定的片段判。
 */
const CHUNK = /Loading chunk|Loading CSS chunk|dynamically imported module|Importing a module script failed|error loading dynamically imported/i;

function classify(err: unknown): ErrorKind {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return CHUNK.test(msg) ? 'chunk' : 'crash';
}

type Props = { children: ReactNode; fallback?: (kind: ErrorKind, detail: string) => ReactNode };
type State = { kind: ErrorKind | null; detail: string };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { kind: null, detail: '' };

  static getDerivedStateFromError(err: unknown): State {
    return {
      kind: classify(err),
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }

  componentDidCatch(err: unknown) {
    /* 真实项目里这里上报；演示站点留在控制台，方便自查 */
    console.error('[akari] 渲染出错：', err);
  }

  render() {
    const { kind, detail } = this.state;
    if (!kind) return this.props.children;
    if (this.props.fallback) return this.props.fallback(kind, detail);
    return (
      <ErrorScreen
        kind={kind}
        detail={import.meta.env.DEV ? detail : undefined}
        onRetry={kind === 'crash'
          /* 崩溃可能只是这一次渲染的状态坏了，先就地重试，不必整页重载 */
          ? () => this.setState({ kind: null, detail: '' })
          : undefined}
      />
    );
  }
}

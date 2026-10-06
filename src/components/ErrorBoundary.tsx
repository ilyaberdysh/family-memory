import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode; scope?: 'app' | 'section' }
interface State { failed: boolean }

/** Keeps a rendering error from blanking the whole app; recordings and drafts are already on the device. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };
  static getDerivedStateFromError(): State { return { failed: true }; }
  componentDidCatch(error: unknown, info: ErrorInfo) { console.error('Interface error:', error instanceof Error ? error.message : error, info.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    const section = this.props.scope === 'section';
    return <div className={`error-fallback ${section ? 'is-section' : 'is-app'}`} role="alert">
      <h2>{section ? 'Этот раздел не открылся' : 'Что-то пошло не так'}</h2>
      <p>Произошла ошибка в приложении. Начатые записи с диктофона и набранный текст обычно сохраняются на этом устройстве — после перезагрузки страница предложит их восстановить.</p>
      <div className="error-fallback-actions">
        <button type="button" className="button primary" onClick={() => window.location.reload()}>Перезагрузить страницу</button>
        {section && <button type="button" className="button secondary" onClick={() => this.setState({ failed: false })}>Попробовать ещё раз</button>}
      </div>
    </div>;
  }
}

/**
 * Страница-заглушка WebView: каркас панели DSH.
 *
 * Настоящая панель (лента чата, tool-call-блоки, composer) — задача #005
 * и следующие за ней.
 */
export function App() {
  return (
    <main className="dsh-panel">
      <header className="dsh-panel__header">
        <h1>DSH</h1>
        <span className="dsh-panel__status">idle</span>
      </header>
      <section className="dsh-panel__body">
        <p>Панель DSH собирается здесь.</p>
        <p className="dsh-panel__hint">
          Каркас WebView: React + Vite. Лента чата, tool-call-блоки и approvals
          появятся в задачах M1.
        </p>
      </section>
    </main>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { bootLab, GATEWAY_URL, type ExtensionName, type ExtensionStatus, type Lab } from './duckdb';
import ResultGrid, { tableToGrid, type QueryResultData } from './ResultGrid';
import { DEFAULT_QUERY, PRESET_QUERIES } from './queries';

type SidecarState = 'checking' | 'reachable' | 'unreachable';

const EXTENSIONS: Array<{ name: ExtensionName; label: string }> = [
  { name: 'longbridge', label: 'Market Data' },
  { name: 'jev', label: 'AI Decision' },
];

export default function App() {
  const labRef = useRef<Lab | null>(null);
  const [extensions, setExtensions] = useState<Record<ExtensionName, ExtensionStatus>>({
    longbridge: { state: 'idle' },
    jev: { state: 'idle' },
  });
  const [connecting, setConnecting] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  const [sidecar, setSidecar] = useState<SidecarState>('checking');
  // Secrets live in component state only — never persisted.
  const [jevApiKey, setJevApiKey] = useState('');
  const [jevEndpoint, setJevEndpoint] = useState(() => `${GATEWAY_URL}/jev`);
  const [longbridgeBaseUrl, setLongbridgeBaseUrl] = useState(() => GATEWAY_URL);

  const [showSettings, setShowSettings] = useState(false);

  const [sql, setSql] = useState(DEFAULT_QUERY);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResultData | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  const setExtensionStatus = useCallback((name: ExtensionName, status: ExtensionStatus) => {
    setExtensions((prev) => ({ ...prev, [name]: status }));
  }, []);

  const checkSidecar = useCallback(async () => {
    setSidecar('checking');
    try {
      // The gateway answers 404 on /jev/ root; only a 5xx (or a network
      // failure) means it is actually down.
      const res = await fetch(`${GATEWAY_URL}/jev/`);
      setSidecar(res.status < 500 ? 'reachable' : 'unreachable');
    } catch {
      setSidecar('unreachable');
    }
  }, []);

  useEffect(() => {
    void checkSidecar();
  }, [checkSidecar]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setBootError(null);
    if (labRef.current) {
      const old = labRef.current;
      labRef.current = null;
      try {
        await old.conn.close();
        await old.db.terminate();
      } catch {
        // tearing down a half-booted instance can throw; ignore
      }
    }
    try {
      labRef.current = await bootLab(
        { jevApiKey, jevEndpoint, longbridgeBaseUrl },
        setExtensionStatus,
      );
    } catch (err) {
      setBootError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }, [jevApiKey, jevEndpoint, longbridgeBaseUrl, setExtensionStatus]);

  // Connect automatically on first load; the button remains for manual reloads.
  const autoConnectRef = useRef(false);
  useEffect(() => {
    if (autoConnectRef.current) return;
    autoConnectRef.current = true;
    void connect();
  }, [connect]);

  const runQuery = useCallback(async () => {
    const lab = labRef.current;
    if (!lab) {
      setQueryError('Not connected — press "Connect / Reload extensions" first.');
      return;
    }
    setRunning(true);
    setQueryError(null);
    try {
      const started = performance.now();
      const table = await lab.conn.query(sql);
      setResult(tableToGrid(table as never, performance.now() - started));
    } catch (err) {
      setResult(null);
      setQueryError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [sql]);

  const connected = labRef.current !== null && !connecting;
  const extErrors = Object.values(extensions).filter((s) => s.state === 'error');

  return (
    <div className="page">
      <header className="header">
        <h1>DuckDB Trading Lab</h1>
        <div className="header-actions">
          <button className="ghost" onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? 'Hide settings' : 'Settings'}
          </button>
          <button className="primary" onClick={connect} disabled={connecting}>
            {connecting ? 'Connecting…' : connected ? 'Reload extensions' : 'Connect / Reload extensions'}
          </button>
        </div>
      </header>

      {(extErrors.length > 0 || bootError) && (
        <section className="panel">
          {extErrors.map((status, i) => (
            <div key={i} className="error-box">
              {status.message}
            </div>
          ))}
          {bootError && extErrors.length === 0 && <div className="error-box">{bootError}</div>}
        </section>
      )}

      {showSettings && (
        <>
          <section className="panel">
            <div className="ext-row">
              <span className="ext-label">Extensions:</span>
              {EXTENSIONS.map(({ name, label }) => {
                const status = extensions[name];
                return (
                  <span key={name} className={`ext-pill ext-${status.state}`} title={status.message}>
                    ● {name} — {label} <em>({status.state})</em>
                  </span>
                );
              })}
            </div>
          </section>

          <section className="panel config-row">
        <button className={`sidecar-pill sidecar-${sidecar}`} onClick={checkSidecar} title="Click to re-check">
          sidecar {sidecar === 'checking' ? '…' : sidecar === 'reachable' ? '● reachable' : '● unreachable'}
        </button>
        <label>
          Jev API key
          <input
            type="password"
            value={jevApiKey}
            onChange={(e) => setJevApiKey(e.target.value)}
            placeholder="leave empty for demo mode"
            autoComplete="off"
          />
        </label>
        <label>
          Jev endpoint
          <input value={jevEndpoint} onChange={(e) => setJevEndpoint(e.target.value)} />
        </label>
        <label>
          Longbridge base URL
          <input value={longbridgeBaseUrl} onChange={(e) => setLongbridgeBaseUrl(e.target.value)} />
        </label>
      </section>
          <p className="hint">
            No key? A <code>demo</code> jev secret pointing at <code>{GATEWAY_URL}/jev</code> is created so the
            gateway's synthetic mode answers. Keys are kept in memory only. Gateway: <code>{GATEWAY_URL}</code>.
          </p>
        </>
      )}

      <section className="panel">
        <div className="sql-toolbar">
          <span className="ext-label">SQL Workspace</span>
          <select
            value=""
            onChange={(e) => {
              const preset = PRESET_QUERIES[Number(e.target.value)];
              if (preset) setSql(preset.sql);
            }}
          >
            <option value="" disabled>
              Presets…
            </option>
            {PRESET_QUERIES.map((preset, i) => (
              <option key={i} value={i}>
                {preset.label}
              </option>
            ))}
          </select>
          <button className="primary" onClick={runQuery} disabled={running || connecting}>
            {running ? 'Running…' : 'Run ⌘⏎'}
          </button>
        </div>
        <textarea
          className="sql-editor"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void runQuery();
            }
          }}
          spellCheck={false}
          rows={16}
        />
      </section>

      <section className="panel">
        <span className="ext-label">Result</span>
        {queryError && <pre className="error-box">{queryError}</pre>}
        {result ? (
          <ResultGrid result={result} />
        ) : (
          !queryError && <p className="hint">Run a query to see results here.</p>
        )}
      </section>
    </div>
  );
}

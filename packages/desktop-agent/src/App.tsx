import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tab = "overview" | "profile" | "logs";

interface AgentInfo {
  version: string;
  platform: string;
  capabilities: string[];
}

// profile is an arbitrary JSON object returned by the Rust side
type Profile = Record<string, unknown> | null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number
): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const savedFetcher = useRef(fetcher);
  savedFetcher.current = fetcher;

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const result = await savedFetcher.current();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    run();
    const id = setInterval(run, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return { data, error };
}

// ---------------------------------------------------------------------------
// Sub-components (inline, no separate files)
// ---------------------------------------------------------------------------

function TabBar({
  active,
  onChange,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
}) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "profile", label: "Profile" },
    { id: "logs", label: "Logs" },
  ];
  return (
    <nav className="tab-bar" role="tablist" aria-label="Settings sections">
      {tabs.map(({ id, label }) => (
        <button
          key={id}
          role="tab"
          aria-selected={active === id}
          aria-controls={`panel-${id}`}
          id={`tab-${id}`}
          className={`tab-btn${active === id ? " active" : ""}`}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className="status-dot"
      style={{ background: ok ? "var(--success)" : "var(--muted)" }}
      aria-hidden="true"
    />
  );
}

function ErrorBadge({ message }: { message: string }) {
  return (
    <span className="error-badge" role="alert">
      {message}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tab: Overview
// ---------------------------------------------------------------------------

function OverviewTab() {
  const fetchAgentInfo = useCallback(
    () => invoke<AgentInfo>("bridge_agent_info"),
    []
  );
  const { data: agentInfo, error: agentError } = usePolling(
    fetchAgentInfo,
    3000
  );

  const fetchPairKeyPath = useCallback(
    () => invoke<string>("bridge_get_pair_key_path"),
    []
  );
  const { data: pairKeyPath, error: pairKeyPathError } = usePolling(
    fetchPairKeyPath,
    15000
  );

  const [pairKeyB64, setPairKeyB64] = useState<string | null>(null);
  const [pairKeyError, setPairKeyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Fetch pair key content whenever path changes
  useEffect(() => {
    if (!pairKeyPath) return;
    let cancelled = false;
    invoke<string>("bridge_read_pair_key_b64")
      .then((b64) => {
        if (!cancelled) {
          setPairKeyB64(b64);
          setPairKeyError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPairKeyError(
            "Unable to read pair key; check agent logs."
          );
          setPairKeyB64(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pairKeyPath]);

  const handleCopyPairKey = useCallback(async () => {
    const value = pairKeyB64 ?? pairKeyPath ?? "";
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API unavailable in some contexts
    }
  }, [pairKeyB64, pairKeyPath]);

  const version = agentInfo?.version ?? "—";
  const platform = agentInfo?.platform ?? "—";
  const capabilities =
    agentInfo?.capabilities?.join(" · ") ?? "—";

  return (
    <section
      id="panel-overview"
      role="tabpanel"
      aria-labelledby="tab-overview"
      className="tab-content"
    >
      {/* Title block */}
      <div className="overview-hero">
        <h1 className="overview-title">AccessBridge Desktop Agent</h1>
        <p className="overview-subtitle">
          Extends AccessBridge to native Windows apps
        </p>
      </div>

      {/* Status grid */}
      <div className="card status-card">
        <h2 className="section-label">Agent Status</h2>
        {agentError && <ErrorBadge message={`bridge_agent_info: ${agentError}`} />}
        <div className="status-grid">
          <div className="status-cell">
            <span className="status-cell-label">Version</span>
            <span className="status-cell-value">{version}</span>
          </div>
          <div className="status-cell">
            <span className="status-cell-label">Platform</span>
            <span className="status-cell-value">{platform}</span>
          </div>
          <div className="status-cell status-cell--wide">
            <span className="status-cell-label">Capabilities</span>
            <span className="status-cell-value">{capabilities}</span>
          </div>
          <div className="status-cell">
            <span className="status-cell-label">Pair Key File</span>
            {pairKeyPathError ? (
              <ErrorBadge message={pairKeyPathError} />
            ) : pairKeyPath ? (
              <button
                className="copy-path-btn"
                title="Copy path to clipboard"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(pairKeyPath);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  } catch {
                    // ignore
                  }
                }}
              >
                <span className="copy-path-text">{pairKeyPath}</span>
                <span className="copy-path-icon" aria-hidden="true">
                  {/* clipboard icon */}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </span>
              </button>
            ) : (
              <span className="status-cell-value muted">Loading…</span>
            )}
          </div>
        </div>
      </div>

      {/* Pair Key section */}
      <div className="card pair-key-card">
        <h2 className="section-label">Pair Key</h2>
        <p className="pair-key-hint">
          Share this key with the Chrome extension's popup &rarr; Pair Agent
          dialog.
        </p>

        {pairKeyError ? (
          <p className="pair-key-error" role="alert">
            {pairKeyError}
          </p>
        ) : (
          <>
            <div className="pair-key-row">
              <input
                className="pair-key-input"
                type="text"
                readOnly
                value={pairKeyB64 ?? ""}
                placeholder="Loading pair key…"
                aria-label="Pair key (base64)"
                spellCheck={false}
              />
              <button
                className="btn-primary copy-btn"
                onClick={handleCopyPairKey}
                disabled={!pairKeyB64}
                aria-label="Copy pair key to clipboard"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Extension connection status (Phase 2 placeholder) */}
      <div className="card connection-card">
        <h2 className="section-label">Extension Connection</h2>
        <div className="connection-row">
          <StatusDot ok={false} />
          <span className="connection-label">Unknown</span>
          <span className="polling-badge">(polling…)</span>
        </div>
        <p className="connection-note muted">
          Live connection status is a Phase 2 enhancement.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tab: Profile
// ---------------------------------------------------------------------------

function ProfileTab() {
  const fetchProfile = useCallback(
    () => invoke<Profile>("bridge_get_profile"),
    []
  );
  const { data: profile, error: profileError } = usePolling(
    fetchProfile,
    3000
  );

  const handleExport = useCallback(() => {
    if (profile == null) return;
    const json = JSON.stringify(profile, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "accessbridge-profile.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [profile]);

  const isEmpty =
    profile == null ||
    (typeof profile === "object" && Object.keys(profile).length === 0);

  return (
    <section
      id="panel-profile"
      role="tabpanel"
      aria-labelledby="tab-profile"
      className="tab-content"
    >
      <div className="card">
        <h2 className="section-label">Accessibility Profile</h2>

        {profileError && (
          <ErrorBadge message={`bridge_get_profile: ${profileError}`} />
        )}

        {!profileError && isEmpty ? (
          <p className="muted profile-empty">
            No profile synced yet. Pair the extension and edit your
            accessibility settings there — changes will appear here.
          </p>
        ) : !profileError && profile != null ? (
          <>
            <pre className="profile-json" aria-label="Profile JSON">
              {JSON.stringify(profile, null, 2)}
            </pre>
            <div className="profile-actions">
              <button className="btn-primary" onClick={handleExport}>
                Export JSON
              </button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tab: Logs
// ---------------------------------------------------------------------------

function LogsTab() {
  return (
    <section
      id="panel-logs"
      role="tabpanel"
      aria-labelledby="tab-logs"
      className="tab-content"
    >
      <div className="card">
        <h2 className="section-label">Log Output</h2>
        <p className="muted logs-note">
          Logs stream to the system log. For live tail, run the agent with{" "}
          <code className="inline-code">RUST_LOG=debug</code>.
        </p>
        <div className="log-path-block">
          <span className="log-path-label">Log file location</span>
          <code className="log-path-value">
            %LOCALAPPDATA%\AccessBridge\agent.log
          </code>
          <p className="muted log-path-note">
            This file is written once the agent is running. If it does not
            exist, the agent has not yet started or has not written a log entry.
          </p>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Root App
// ---------------------------------------------------------------------------

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  // Fetch version for footer — low-frequency, no polling needed
  const [footerVersion, setFooterVersion] = useState<string>("0.1.0");
  useEffect(() => {
    invoke<AgentInfo>("bridge_agent_info")
      .then((info) => setFooterVersion(info.version))
      .catch(() => {
        // keep default
      });
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-brand">AccessBridge</span>
        <span className="app-header-title">Desktop Agent</span>
      </header>

      <TabBar active={activeTab} onChange={setActiveTab} />

      <main className="tab-pane">
        {activeTab === "overview" && <OverviewTab />}
        {activeTab === "profile" && <ProfileTab />}
        {activeTab === "logs" && <LogsTab />}
      </main>

      <footer className="app-footer">
        Manish Kumar &mdash; AccessBridge Desktop Agent v{footerVersion}
      </footer>
    </div>
  );
}

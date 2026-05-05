// Header (tabs, refresh, theme toggle) + Login screen
// Globals: Button, Input

function DashboardHeader({ tab, setTab, connected, eventCount, onRefresh, user, repos, selectedRepo, setSelectedRepo, isDark, toggleTheme, onLogout }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: "-0.01em", color: "#fff" }}>
            Danxbot Dashboard
          </h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#9ca3af" }}>
            <span style={{ color: connected ? "#4ade80" : "#f87171" }}>●</span>{" "}
            {connected ? "Connected" : "Disconnected"}
            {tab === "dispatches" && <> · {eventCount} dispatches tracked</>}
            {tab === "issues" && <> · Issues board</>}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {user && <span style={{ fontSize: 13, color: "#9ca3af" }}>{user}</span>}
          {repos?.length > 1 && (tab === "dispatches" || tab === "issues") && (
            <select value={selectedRepo} onChange={(e) => setSelectedRepo(e.target.value)}
              style={{
                padding: "6px 12px", background: "#1f2937", borderRadius: 6,
                fontSize: 13, color: "#d1d5db", border: 0, outline: "none", cursor: "pointer",
                fontFamily: "inherit",
              }}>
              <option value="">All repos</option>
              {repos.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
            </select>
          )}
          <Button onClick={toggleTheme}>{isDark ? "☀️" : "🌙"}</Button>
          <Button onClick={onRefresh}>Refresh</Button>
          {user && <Button onClick={onLogout}>Log out</Button>}
        </div>
      </div>
      <nav role="tablist" style={{
        marginTop: 20, borderBottom: "1px solid #374151", display: "flex", gap: 4,
      }}>
        {[{ id: "dispatches", label: "Dispatches" }, { id: "issues", label: "Issues" }, { id: "agents", label: "Agents" }].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} role="tab"
            aria-selected={tab === t.id}
            style={{
              padding: "8px 16px", fontSize: 13, fontWeight: 500,
              border: 0, background: "none", cursor: "pointer", fontFamily: "inherit",
              borderBottom: `2px solid ${tab === t.id ? "#6366f1" : "transparent"}`,
              color: tab === t.id ? "#a5b4fc" : "#9ca3af",
              marginBottom: -1, transition: "all 150ms",
            }}>{t.label}</button>
        ))}
      </nav>
    </div>
  );
}

function Login({ onLogin }) {
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    setTimeout(() => {
      if (username && password) onLogin({ username });
      else { setError("Login failed"); setPassword(""); }
      setSubmitting(false);
    }, 400);
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center",
      justifyContent: "center", background: "#020617", padding: 16,
    }}>
      <form onSubmit={submit} style={{
        width: "100%", maxWidth: 360, borderRadius: 12,
        border: "1px solid #1f2937", background: "#111827",
        boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.4)", padding: "32px 24px",
      }}>
        <div style={{ marginBottom: 24, textAlign: "center" }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#fff" }}>Danxbot Dashboard</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#9ca3af" }}>Sign in to continue</p>
        </div>
        <label style={{ display: "block", marginBottom: 16 }}>
          <span style={{ display: "block", fontSize: 11, fontWeight: 500, color: "#d1d5db", marginBottom: 4 }}>Username</span>
          <Input value={username} onChange={setUsername} style={{ width: "100%" }} />
        </label>
        <label style={{ display: "block", marginBottom: 16 }}>
          <span style={{ display: "block", fontSize: 11, fontWeight: 500, color: "#d1d5db", marginBottom: 4 }}>Password</span>
          <Input type="password" value={password} onChange={setPassword} style={{ width: "100%" }} />
        </label>
        {error && <p role="alert" style={{ margin: "0 0 16px", fontSize: 13, color: "#f87171" }}>{error}</p>}
        <button type="submit" disabled={submitting} style={{
          width: "100%", borderRadius: 6, background: "#4f46e5", color: "#fff",
          fontSize: 13, fontWeight: 500, padding: "8px 14px", border: 0,
          cursor: submitting ? "not-allowed" : "pointer",
          opacity: submitting ? 0.6 : 1, fontFamily: "inherit",
        }}>{submitting ? "Signing in…" : "Sign in"}</button>
        <p style={{ marginTop: 16, fontSize: 11, color: "#6b7280", textAlign: "center" }}>
          try: any username + password
        </p>
      </form>
    </div>
  );
}

Object.assign(window, { DashboardHeader, Login });

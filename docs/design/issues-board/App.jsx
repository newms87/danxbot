// Top-level app — login + tabs + filter state
// Globals: Login, DashboardHeader, DispatchFilters, DispatchTable, DispatchDetail, RepoCard,
//   IssueBoard, IssueDrawer, FIXTURE_DISPATCHES, FIXTURE_AGENTS, FIXTURE_REPOS, FIXTURE_ISSUES,
//   TweaksPanel, useTweaks, TweakSection, TweakRadio, TweakToggle, TweakSelect

const { useState, useMemo, useEffect } = React;

const ISSUES_TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "cardDensity": "comfortable",
  "epicAccent": "left-bar",
  "blockedTreatment": "border",
  "drawerSide": "right",
  "scopeMode": "highlight",
  "showClosed": false
}/*EDITMODE-END*/;

function App() {
  const [user, setUser] = useState(null);
  const [isDark, setIsDark] = useState(true);
  const [tab, setTab] = useState("issues");
  const [dispatches, setDispatches] = useState(FIXTURE_DISPATCHES);
  const [agents, setAgents] = useState(FIXTURE_AGENTS);
  const [selectedDispatch, setSelectedDispatch] = useState(null);
  const [selectedRepo, setSelectedRepo] = useState("platform");
  const [selectedTrigger, setSelectedTrigger] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("");
  const [search, setSearch] = useState("");

  // Issues state
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [scopedEpicId, setScopedEpicId] = useState(null);

  // Tweaks
  const [tweaks, setTweak] = useTweaks(ISSUES_TWEAK_DEFAULTS);

  const filtered = useMemo(() => dispatches.filter((d) => {
    if (selectedRepo && d.repoName !== selectedRepo) return false;
    if (selectedTrigger && d.trigger !== selectedTrigger) return false;
    if (selectedStatus && d.status !== selectedStatus) return false;
    if (search && !(d.summary + " " + d.context).toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [dispatches, selectedRepo, selectedTrigger, selectedStatus, search]);

  const toggleFeature = (repo, feature, enabled) => {
    setAgents((prev) => prev.map((a) => a.name === repo
      ? { ...a, features: { ...a.features, [feature]: { enabled } } } : a));
  };

  const issueRepo = selectedRepo || "platform";
  const jumpToIssue = (id) => {
    const i = FIXTURE_ISSUES.find((x) => x.id === id);
    if (i) {
      if (i.repo !== issueRepo) setSelectedRepo(i.repo);
      setSelectedIssue(i);
    }
  };

  const refresh = () => {};

  if (!user) return <Login onLogin={setUser} />;

  return (
    <div style={{ minHeight: "100vh", background: isDark ? "#020617" : "#f9fafb",
                  color: isDark ? "#f1f5f9" : "#111827", padding: "24px 16px" }}>
      <DashboardHeader
        tab={tab} setTab={setTab}
        connected={true} eventCount={dispatches.length}
        onRefresh={refresh}
        user={user.username}
        repos={FIXTURE_REPOS}
        selectedRepo={selectedRepo} setSelectedRepo={setSelectedRepo}
        isDark={isDark} toggleTheme={() => setIsDark(!isDark)}
        onLogout={() => setUser(null)}
      />
      {tab === "dispatches" && (
        <>
          <DispatchFilters
            trigger={selectedTrigger} setTrigger={setSelectedTrigger}
            status={selectedStatus} setStatus={setSelectedStatus}
            search={search} setSearch={setSearch}
          />
          <DispatchTable dispatches={filtered} onSelect={setSelectedDispatch} />
          {selectedDispatch && (
            <DispatchDetail dispatch={selectedDispatch} onClose={() => setSelectedDispatch(null)} />
          )}
        </>
      )}
      {tab === "issues" && (
        <>
          <IssueBoard
            issues={FIXTURE_ISSUES}
            repo={issueRepo}
            tweaks={tweaks}
            onSelectIssue={setSelectedIssue}
            scopedEpicId={scopedEpicId}
            setScopedEpicId={setScopedEpicId}
          />
          {selectedIssue && (
            <IssueDrawer
              issue={selectedIssue}
              allIssues={FIXTURE_ISSUES}
              onClose={() => setSelectedIssue(null)}
              onJumpIssue={jumpToIssue}
              scopedEpicId={scopedEpicId}
              onScopeEpic={setScopedEpicId}
            />
          )}
        </>
      )}
      {tab === "agents" && (
        <div style={{ display: "grid", gap: 16 }}>
          {agents.map((a) => (
            <RepoCard key={a.name} agent={a} onToggle={toggleFeature} />
          ))}
        </div>
      )}

      <TweaksPanel title="Tweaks">
        <TweakSection title="Board">
          <TweakRadio
            label="Card density"
            value={tweaks.cardDensity}
            onChange={(v) => setTweak("cardDensity", v)}
            options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfort" },
            ]}
          />
          <TweakRadio
            label="Epic accent"
            value={tweaks.epicAccent}
            onChange={(v) => setTweak("epicAccent", v)}
            options={[
              { value: "left-bar", label: "Left bar" },
              { value: "tint", label: "Tint" },
              { value: "outline", label: "Outline" },
            ]}
          />
          <TweakRadio
            label="Blocked treatment"
            value={tweaks.blockedTreatment}
            onChange={(v) => setTweak("blockedTreatment", v)}
            options={[
              { value: "border", label: "Border" },
              { value: "icon", label: "Icon" },
              { value: "tint", label: "Tint" },
            ]}
          />
        </TweakSection>
        <TweakSection title="Epic scope">
          <TweakRadio
            label="Default mode"
            value={tweaks.scopeMode}
            onChange={(v) => setTweak("scopeMode", v)}
            options={[
              { value: "highlight", label: "Highlight" },
              { value: "filter", label: "Filter" },
            ]}
          />
        </TweakSection>
        <TweakSection title="Drawer">
          <TweakRadio
            label="Side"
            value={tweaks.drawerSide}
            onChange={(v) => setTweak("drawerSide", v)}
            options={[
              { value: "right", label: "Right" },
              { value: "left", label: "Left" },
            ]}
          />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("app")).render(<App />);

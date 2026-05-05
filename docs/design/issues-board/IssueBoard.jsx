// IssueBoard — kanban with 6 columns, scoped epic state, dim/filter modes
// Globals: IssueCard, STATUS_COLUMNS, ISSUE_TYPE_META

const { useState: useBoardState, useMemo: useBoardMemo } = React;

function ColumnHeader({ label, count, collapsed, onToggle, accent }) {
  return (
    <button
      onClick={onToggle}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 4px 10px 6px", width: "100%",
        background: "none", border: 0, cursor: "pointer",
        fontFamily: "inherit", color: "#94a3b8",
        borderBottom: `1px solid ${accent || "#1e293b"}`,
      }}
    >
      <span style={{
        width: 6, height: 6, borderRadius: 9999, background: accent || "#475569",
      }} />
      <span style={{
        fontSize: 11, fontWeight: 600, textTransform: "uppercase",
        letterSpacing: "0.05em", color: "#cbd5e1",
      }}>{label}</span>
      <span style={{
        fontSize: 10, fontWeight: 600, color: "#64748b",
        padding: "1px 6px", borderRadius: 9999,
        background: "rgb(51 65 85 / 0.4)",
        fontVariantNumeric: "tabular-nums",
      }}>{count}</span>
      <span style={{ marginLeft: "auto", fontSize: 10, color: "#64748b" }}>
        {collapsed ? "▸" : "▾"}
      </span>
    </button>
  );
}

const COLUMN_ACCENTS = {
  review:      "#a78bfa",
  todo:        "#64748b",
  in_progress: "#fcd34d",
  needs_help:  "#ef4444",
  done:        "#10b981",
  cancelled:   "#475569",
};

function FilterToolbar({
  search, setSearch,
  typeFilters, toggleType,
  blockedOnly, setBlockedOnly,
  showClosed, setShowClosed,
  scopedEpicId, scopedEpic, onClearScope,
  scopeMode, setScopeMode,
  totalCount, visibleCount,
}) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 10,
      padding: "12px 16px", borderRadius: 8,
      background: "rgb(15 23 42 / 0.5)",
      border: "1px solid #1e293b",
      marginBottom: 16,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {/* Quiet search */}
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "5px 10px", borderRadius: 6,
          background: search ? "rgb(30 41 59 / 0.8)" : "rgb(15 23 42 / 0.4)",
          border: `1px solid ${search ? "#334155" : "transparent"}`,
          flex: "1 1 220px", minWidth: 180, maxWidth: 360,
          transition: "all 150ms",
        }}>
          <span style={{ fontSize: 11, color: "#475569" }}>⌕</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search id, title, description, comments…"
            style={{
              flex: 1, background: "transparent", border: 0, outline: "none",
              color: "#e2e8f0", fontSize: 12, fontFamily: "inherit",
            }}
          />
          {search && (
            <button onClick={() => setSearch("")} style={{
              background: "none", border: 0, color: "#64748b",
              cursor: "pointer", fontFamily: "inherit", fontSize: 12,
            }}>×</button>
          )}
        </div>

        {/* Type chips */}
        <div style={{ display: "flex", gap: 4 }}>
          {["epic", "bug", "feature"].map((t) => {
            const active = typeFilters.includes(t);
            const m = ISSUE_TYPE_META[t];
            return (
              <button key={t} onClick={() => toggleType(t)} style={{
                padding: "4px 10px", borderRadius: 9999, fontSize: 11, fontWeight: 600,
                color: active ? m.fg : "#94a3b8",
                background: active ? m.bg : "rgb(30 41 59 / 0.5)",
                border: `1px solid ${active ? m.border : "#334155"}`,
                cursor: "pointer", fontFamily: "inherit",
                textTransform: "capitalize", letterSpacing: "0.02em",
              }}>{m.label}</button>
            );
          })}
        </div>

        {/* Blocked toggle */}
        <button onClick={() => setBlockedOnly(!blockedOnly)} style={{
          padding: "4px 10px", borderRadius: 9999, fontSize: 11, fontWeight: 600,
          color: blockedOnly ? "#fca5a5" : "#94a3b8",
          background: blockedOnly ? "rgb(239 68 68 / 0.15)" : "rgb(30 41 59 / 0.5)",
          border: `1px solid ${blockedOnly ? "rgb(239 68 68 / 0.35)" : "#334155"}`,
          cursor: "pointer", fontFamily: "inherit",
        }}>⛔ Blocked only</button>

        {/* Closed toggle */}
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "#94a3b8", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
            style={{ accentColor: "#6366f1", cursor: "pointer" }}
          />
          Show closed
        </label>

        <span style={{ marginLeft: "auto", fontSize: 11, color: "#64748b" }}>
          {visibleCount} of {totalCount}
        </span>
      </div>

      {/* Active scope row */}
      {scopedEpicId && scopedEpic && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
          borderRadius: 6, background: "rgb(99 102 241 / 0.1)",
          border: "1px solid rgb(99 102 241 / 0.3)",
        }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "#a5b4fc" }}>
            Scoped to epic
          </span>
          <span style={{ fontSize: 11, color: "#64748b", fontVariantNumeric: "tabular-nums" }}>
            {scopedEpicId}
          </span>
          <span style={{
            fontSize: 12, color: "#e2e8f0", flex: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{scopedEpic.title}</span>
          <div style={{
            display: "inline-flex", borderRadius: 4, overflow: "hidden",
            border: "1px solid #334155",
          }}>
            {[
              { id: "filter",    label: "Filter" },
              { id: "highlight", label: "Highlight" },
            ].map((m) => (
              <button key={m.id} onClick={() => setScopeMode(m.id)} style={{
                padding: "3px 10px", fontSize: 10, fontWeight: 600,
                background: scopeMode === m.id ? "rgb(99 102 241 / 0.25)" : "transparent",
                color: scopeMode === m.id ? "#c7d2fe" : "#94a3b8",
                border: 0, cursor: "pointer", fontFamily: "inherit",
              }}>{m.label}</button>
            ))}
          </div>
          <button onClick={onClearScope} style={{
            padding: "2px 8px", fontSize: 11, fontWeight: 500, color: "#94a3b8",
            background: "rgb(30 41 59 / 0.5)", border: "1px solid #334155",
            borderRadius: 4, cursor: "pointer", fontFamily: "inherit",
          }}>Clear ×</button>
        </div>
      )}
    </div>
  );
}

function IssueBoard({ issues, repo, tweaks, onSelectIssue, scopedEpicId, setScopedEpicId }) {
  const [search, setSearch] = useBoardState("");
  const [typeFilters, setTypeFilters] = useBoardState([]);
  const [blockedOnly, setBlockedOnly] = useBoardState(false);
  const [showClosed, setShowClosed] = useBoardState(false);
  const [scopeMode, setScopeMode] = useBoardState("highlight");
  const [collapsed, setCollapsed] = useBoardState({ done: true, cancelled: true });

  const repoIssues = useBoardMemo(
    () => issues.filter((i) => i.repo === repo),
    [issues, repo]
  );

  const scopedEpic = useBoardMemo(
    () => scopedEpicId ? repoIssues.find((i) => i.id === scopedEpicId) : null,
    [scopedEpicId, repoIssues]
  );

  const isInScope = (i) => {
    if (!scopedEpicId) return true;
    return i.id === scopedEpicId || i.parent_id === scopedEpicId;
  };

  const baseFiltered = useBoardMemo(() => {
    return repoIssues.filter((i) => {
      if (typeFilters.length > 0 && !typeFilters.includes(i.type)) return false;
      if (blockedOnly && !i.blocked) return false;
      if (search) {
        const hay = (i.id + " " + i.title + " " + (i.description || "")).toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [repoIssues, typeFilters, blockedOnly, search]);

  const visible = useBoardMemo(() => {
    return baseFiltered.filter((i) => {
      // closed handling
      if (!showClosed && (i.status === "done" || i.status === "cancelled")) {
        // still show inside collapsed columns; column collapse handles render
      }
      // filter scope mode hides unrelated
      if (scopedEpicId && scopeMode === "filter" && !isInScope(i)) return false;
      return true;
    });
  }, [baseFiltered, scopedEpicId, scopeMode, showClosed]);

  const grouped = useBoardMemo(() => {
    const g = {};
    STATUS_COLUMNS.forEach((c) => g[c.id] = []);
    visible.forEach((i) => {
      if (g[i.status]) g[i.status].push(i);
    });
    // sort: epics first, then by updatedAt desc
    Object.keys(g).forEach((k) => {
      g[k].sort((a, b) => {
        if ((a.type === "epic") !== (b.type === "epic")) return a.type === "epic" ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });
    });
    return g;
  }, [visible]);

  const toggleType = (t) => setTypeFilters((prev) =>
    prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
  );

  const toggleCollapsed = (id) => setCollapsed((p) => ({ ...p, [id]: !p[id] }));

  const visibleColumns = STATUS_COLUMNS.filter((c) =>
    showClosed || (c.id !== "done" && c.id !== "cancelled") || grouped[c.id].length > 0
  );

  return (
    <div>
      <FilterToolbar
        search={search} setSearch={setSearch}
        typeFilters={typeFilters} toggleType={toggleType}
        blockedOnly={blockedOnly} setBlockedOnly={setBlockedOnly}
        showClosed={showClosed} setShowClosed={setShowClosed}
        scopedEpicId={scopedEpicId} scopedEpic={scopedEpic}
        onClearScope={() => setScopedEpicId(null)}
        scopeMode={scopeMode} setScopeMode={setScopeMode}
        totalCount={repoIssues.length} visibleCount={visible.length}
      />

      <div style={{
        display: "grid",
        gridTemplateColumns: visibleColumns.map((c) => collapsed[c.id] ? "minmax(180px, 1fr)" : "minmax(260px, 1fr)").join(" "),
        gap: 12, alignItems: "start",
        overflowX: "auto", paddingBottom: 8,
      }}>
        {visibleColumns.map((col) => {
          const isCollapsed = !!collapsed[col.id];
          const items = grouped[col.id] || [];
          return (
            <div key={col.id} style={{
              minWidth: isCollapsed ? 180 : 260,
              display: "flex", flexDirection: "column", gap: 8,
            }}>
              <ColumnHeader
                label={col.label}
                count={items.length}
                collapsed={isCollapsed}
                onToggle={() => toggleCollapsed(col.id)}
                accent={COLUMN_ACCENTS[col.id]}
              />
              {!isCollapsed && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {items.length === 0 ? (
                    <div style={{
                      padding: "20px 12px", textAlign: "center",
                      fontSize: 11, color: "#475569",
                      border: "1px dashed #1e293b", borderRadius: 8,
                    }}>No items</div>
                  ) : (
                    items.map((i) => (
                      <IssueCard
                        key={i.id}
                        issue={i}
                        onClick={() => onSelectIssue(i)}
                        dimmed={scopedEpicId && scopeMode === "highlight" && !isInScope(i)}
                        scoped={scopedEpicId && isInScope(i)}
                        onParentClick={(pid) => setScopedEpicId(pid)}
                      />
                    ))
                  )}
                </div>
              )}
              {isCollapsed && items.length > 0 && (
                <div style={{
                  padding: "8px 10px", fontSize: 11, color: "#64748b",
                  background: "rgb(15 23 42 / 0.4)", borderRadius: 6,
                  border: "1px solid #1e293b",
                }}>{items.length} hidden — click header to expand</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

Object.assign(window, { IssueBoard });

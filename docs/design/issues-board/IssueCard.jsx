// IssueCard + EpicCard — kanban cards for the Issues board.
// Globals: ISSUE_TYPE_META, PHASE_STATUS_META, relativeTime

const ICard_truncateLeft = (s, n = 28) =>
  s.length > n ? s.slice(0, n).trim() + "…" : s;

function ACBar({ ac }) {
  const total = ac.length;
  const done = ac.filter((a) => a.done).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
      <div style={{
        flex: 1, height: 4, borderRadius: 9999,
        background: "rgb(51 65 85 / 0.6)", overflow: "hidden",
      }}>
        <div style={{
          width: `${pct}%`, height: "100%",
          background: pct === 100 ? "#10b981" : "#6366f1",
          transition: "width 200ms",
        }} />
      </div>
      <span style={{ fontSize: 11, color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
        {done}/{total}
      </span>
    </div>
  );
}

function PhaseChecklist({ phases }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
      {phases.map((p, i) => {
        const m = PHASE_STATUS_META[p.status] || PHASE_STATUS_META.todo;
        return (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 8,
            fontSize: 12, lineHeight: 1.3,
            color: p.status === "done" ? "#64748b" : "#cbd5e1",
            textDecoration: p.status === "done" ? "line-through" : "none",
          }}>
            <span style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 16, height: 16, borderRadius: 4, flexShrink: 0,
              background: m.bg, color: m.fg, fontSize: 10, fontWeight: 600,
            }}>{m.glyph}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {i + 1}: {p.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TypeBadge({ type, compact }) {
  const m = ISSUE_TYPE_META[type] || ISSUE_TYPE_META.feature;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: compact ? "1px 6px" : "2px 8px",
      borderRadius: 4, fontSize: 10, fontWeight: 600,
      background: m.bg, color: m.fg, border: `1px solid ${m.border}`,
      letterSpacing: "0.02em",
    }}>{m.label}</span>
  );
}

function IssueCard({ issue, onClick, dimmed, scoped, onParentClick }) {
  const isEpic = issue.type === "epic";
  const blocked = !!issue.blocked;
  const m = ISSUE_TYPE_META[issue.type];
  const accent = isEpic ? "#6366f1" : null;

  return (
    <button
      onClick={onClick}
      style={{
        textAlign: "left", width: "100%", display: "block",
        background: scoped
          ? "rgb(99 102 241 / 0.08)"
          : (isEpic ? "rgb(30 27 75 / 0.45)" : "rgb(15 23 42 / 0.7)"),
        border: `1px solid ${scoped ? "rgb(99 102 241 / 0.5)" : (isEpic ? "rgb(99 102 241 / 0.35)" : "#1e293b")}`,
        borderLeft: blocked ? "3px solid #ef4444" : (isEpic ? `3px solid ${accent}` : `1px solid ${scoped ? "rgb(99 102 241 / 0.5)" : "#1e293b"}`),
        borderRadius: 8, padding: "10px 12px",
        opacity: dimmed ? 0.32 : 1,
        cursor: "pointer", fontFamily: "inherit",
        boxShadow: scoped ? "0 0 0 1px rgb(99 102 241 / 0.2), 0 4px 12px rgb(99 102 241 / 0.08)" : "0 1px 0 rgb(0 0 0 / 0.2)",
        transition: "opacity 150ms, background-color 150ms, transform 100ms",
      }}
      onMouseEnter={(e) => { if (!dimmed) e.currentTarget.style.transform = "translateY(-1px)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; }}
    >
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{
          fontSize: 10, fontWeight: 600, color: "#64748b",
          fontVariantNumeric: "tabular-nums", letterSpacing: "0.02em",
        }}>{issue.id}</span>
        <TypeBadge type={issue.type} compact />
        {isEpic && (
          <span style={{
            fontSize: 10, fontWeight: 500, color: "#a5b4fc",
            padding: "1px 6px", borderRadius: 4,
            background: "rgb(99 102 241 / 0.12)",
          }}>{issue.phases.length} phases</span>
        )}
        {blocked && (
          <span title={issue.blocked.reason} style={{
            marginLeft: "auto", fontSize: 10, fontWeight: 600, color: "#fca5a5",
            display: "inline-flex", alignItems: "center", gap: 3,
          }}>
            <span style={{ fontSize: 9 }}>⛔</span> Blocked
          </span>
        )}
      </div>

      {/* Title */}
      <div style={{
        fontSize: 13, fontWeight: 500, color: "#e2e8f0",
        lineHeight: 1.35,
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
      }}>{issue.title}</div>

      {/* Epic: phase checklist */}
      {isEpic && issue.phases.length > 0 && <PhaseChecklist phases={issue.phases} />}

      {/* Non-epic: AC progress bar */}
      {!isEpic && issue.ac.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <ACBar ac={issue.ac} />
        </div>
      )}

      {/* Footer */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        marginTop: 10, fontSize: 11, color: "#64748b",
      }}>
        {issue.parent_id && (
          <button
            onClick={(e) => { e.stopPropagation(); onParentClick && onParentClick(issue.parent_id); }}
            style={{
              padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 500,
              color: "#a5b4fc", background: "rgb(99 102 241 / 0.12)",
              border: "1px solid rgb(99 102 241 / 0.25)",
              cursor: "pointer", fontFamily: "inherit",
            }}
            title={`Parent epic ${issue.parent_id}`}
          >↑ {issue.parent_id}</button>
        )}
        {issue.comments_count > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
            <span style={{ fontSize: 10 }}>💬</span>{issue.comments_count}
          </span>
        )}
        {issue.has_retro && (
          <span style={{ color: "#86efac", fontSize: 10 }}>retro</span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 10 }}>{relativeTime(issue.updatedAt)}</span>
      </div>
    </button>
  );
}

Object.assign(window, { IssueCard, TypeBadge, ACBar, PhaseChecklist });

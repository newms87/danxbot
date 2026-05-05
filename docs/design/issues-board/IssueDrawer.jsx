// IssueDrawer — slide-over panel with Overview / Comments / Retro / Raw tabs
// Globals: TypeBadge, PhaseChecklist, ISSUE_TYPE_META, PHASE_STATUS_META, relativeTime

const { useState: useDrawerState, useMemo: useDrawerMemo } = React;

const FAKE_COMMENTS = {
  "ISS-101": [
    { author: "alice",   ts: Date.now() - 3*3600_000,  text: "Reproed in staging. Backoff is unbounded — see logs from 14:01." },
    { author: "danxbot", ts: Date.now() - 2*3600_000,  text: "Adding Retry-After honoring as a first pass." },
    { author: "bob",     ts: Date.now() - 90*60_000,   text: "Should we cap the queue at 200 or 500? Trello's docs aren't clear." },
    { author: "alice",   ts: Date.now() - 30*60_000,   text: "200 is fine — anything more and we'd want to alert anyway." },
  ],
  "ISS-204": [
    { author: "carlos",  ts: Date.now() - 6*3600_000,  text: "Saw two warnings in #platform-alerts at 09:14 and 09:15. Same token." },
    { author: "danxbot", ts: Date.now() - 5*3600_000,  text: "Confirmed — init-time check + first-dispatch check both fire on cold start." },
    { author: "carlos",  ts: Date.now() - 4*3600_000,  text: "Can we just drop the init-time one once JWT middleware is fully migrated?" },
  ],
};

function commentsFor(issue) {
  return FAKE_COMMENTS[issue.id] || (issue.comments_count > 0 ? [{
    author: "danxbot", ts: issue.updatedAt, text: "(Comments would render here from the YAML's comments[] array.)",
  }] : []);
}

function DrawerHeader({ issue, onClose, onJumpEpic, scoped, onToggleScope }) {
  const m = ISSUE_TYPE_META[issue.type];
  return (
    <div style={{
      padding: "16px 20px 12px", borderBottom: "1px solid #1e293b",
      display: "flex", flexDirection: "column", gap: 10,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          fontSize: 11, fontWeight: 600, color: "#64748b",
          fontVariantNumeric: "tabular-nums", letterSpacing: "0.02em",
        }}>{issue.id}</span>
        <TypeBadge type={issue.type} />
        <span style={{
          fontSize: 11, fontWeight: 500, color: "#cbd5e1",
          padding: "2px 8px", borderRadius: 4, background: "rgb(51 65 85 / 0.5)",
          textTransform: "capitalize",
        }}>{issue.status.replace("_", " ")}</span>
        {issue.blocked && (
          <span style={{
            fontSize: 11, fontWeight: 600, color: "#fca5a5",
            padding: "2px 8px", borderRadius: 4, background: "rgb(239 68 68 / 0.15)",
            border: "1px solid rgb(239 68 68 / 0.3)",
          }}>⛔ Blocked</span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#64748b" }}>
          {relativeTime(issue.updatedAt)}
        </span>
        <button
          onClick={onClose}
          style={{
            background: "none", border: 0, color: "#94a3b8",
            cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 4px",
            fontFamily: "inherit",
          }}
          aria-label="Close"
        >×</button>
      </div>
      <h2 style={{
        margin: 0, fontSize: 18, fontWeight: 600, color: "#f1f5f9",
        lineHeight: 1.3, letterSpacing: "-0.01em",
      }}>{issue.title}</h2>
      {(issue.parent_id || (issue.children && issue.children.length > 0)) && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {issue.parent_id && (
            <button
              onClick={() => onJumpEpic && onJumpEpic(issue.parent_id)}
              style={{
                padding: "3px 8px", borderRadius: 4, fontSize: 11, fontWeight: 500,
                color: "#a5b4fc", background: "rgb(99 102 241 / 0.12)",
                border: "1px solid rgb(99 102 241 / 0.3)",
                cursor: "pointer", fontFamily: "inherit",
              }}
            >↑ Parent: {issue.parent_id}</button>
          )}
          {issue.children && issue.children.length > 0 && (
            <span style={{ fontSize: 11, color: "#64748b" }}>
              {issue.children.length} children
            </span>
          )}
          {(issue.parent_id || issue.type === "epic") && (
            <button
              onClick={onToggleScope}
              style={{
                marginLeft: "auto", padding: "3px 8px", borderRadius: 4,
                fontSize: 11, fontWeight: 500,
                color: scoped ? "#fcd34d" : "#94a3b8",
                background: scoped ? "rgb(245 158 11 / 0.12)" : "rgb(30 41 59 / 0.5)",
                border: `1px solid ${scoped ? "rgb(245 158 11 / 0.3)" : "#334155"}`,
                cursor: "pointer", fontFamily: "inherit",
              }}
            >{scoped ? "✓ Scoped to epic" : "Scope board to epic"}</button>
          )}
        </div>
      )}
    </div>
  );
}

function OverviewTab({ issue, allIssues, onJumpIssue }) {
  const childIssues = useDrawerMemo(
    () => (issue.children || []).map((id) => allIssues.find((i) => i.id === id)).filter(Boolean),
    [issue.children, allIssues]
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, padding: "16px 20px" }}>
      {/* Description */}
      <div>
        <div style={{
          fontSize: 11, fontWeight: 500, textTransform: "uppercase",
          letterSpacing: "0.05em", color: "#64748b", marginBottom: 6,
        }}>Description</div>
        <div style={{
          fontSize: 13, color: "#cbd5e1", lineHeight: 1.55,
          textWrap: "pretty",
        }}>{issue.description || <em style={{ color: "#475569" }}>No description.</em>}</div>
      </div>

      {/* Blocked panel */}
      {issue.blocked && (
        <div style={{
          padding: "10px 12px", borderRadius: 6,
          background: "rgb(239 68 68 / 0.08)",
          border: "1px solid rgb(239 68 68 / 0.25)",
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#fca5a5", marginBottom: 4 }}>
            ⛔ Blocked
          </div>
          <div style={{ fontSize: 13, color: "#fecaca", lineHeight: 1.5 }}>
            {issue.blocked.reason}
          </div>
          {issue.blocked.by && issue.blocked.by.length > 0 && (
            <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "#fca5a5" }}>by:</span>
              {issue.blocked.by.map((bid) => (
                <button key={bid} onClick={() => onJumpIssue(bid)} style={{
                  padding: "1px 6px", borderRadius: 4, fontSize: 11, fontWeight: 500,
                  color: "#fecaca", background: "rgb(239 68 68 / 0.15)",
                  border: "1px solid rgb(239 68 68 / 0.3)",
                  cursor: "pointer", fontFamily: "inherit",
                }}>{bid}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* AC checklist */}
      {issue.ac && issue.ac.length > 0 && (
        <div>
          <div style={{
            fontSize: 11, fontWeight: 500, textTransform: "uppercase",
            letterSpacing: "0.05em", color: "#64748b", marginBottom: 8,
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <span>Acceptance Criteria</span>
            <span style={{ color: "#94a3b8", fontWeight: 400 }}>
              {issue.ac.filter((a) => a.done).length}/{issue.ac.length}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {issue.ac.map((a, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13,
                color: a.done ? "#64748b" : "#e2e8f0",
                lineHeight: 1.4,
              }}>
                <span style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 16, height: 16, borderRadius: 3, flexShrink: 0, marginTop: 1,
                  background: a.done ? "rgb(16 185 129 / 0.18)" : "rgb(51 65 85 / 0.5)",
                  color: a.done ? "#6ee7b7" : "#475569",
                  fontSize: 11, fontWeight: 700,
                }}>{a.done ? "✓" : ""}</span>
                <span style={{
                  textDecoration: a.done ? "line-through" : "none",
                  textWrap: "pretty",
                }}>{a.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Phases */}
      {issue.phases && issue.phases.length > 0 && (
        <div>
          <div style={{
            fontSize: 11, fontWeight: 500, textTransform: "uppercase",
            letterSpacing: "0.05em", color: "#64748b", marginBottom: 8,
          }}>Phases</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {issue.phases.map((p, i) => {
              const m = PHASE_STATUS_META[p.status];
              return (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 10px", borderRadius: 6,
                  background: "rgb(15 23 42 / 0.6)",
                  border: "1px solid #1e293b",
                }}>
                  <span style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 22, height: 22, borderRadius: 4, flexShrink: 0,
                    background: m.bg, color: m.fg, fontSize: 12, fontWeight: 600,
                  }}>{m.glyph}</span>
                  <span style={{ flex: 1, fontSize: 13, color: "#e2e8f0" }}>
                    <span style={{ color: "#64748b" }}>{i + 1}.</span> {p.name}
                  </span>
                  <span style={{
                    fontSize: 10, fontWeight: 600, color: m.fg,
                    padding: "2px 8px", borderRadius: 4, background: m.bg,
                    textTransform: "capitalize",
                  }}>{p.status.replace("_", " ")}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Children (epics) */}
      {childIssues.length > 0 && (
        <div>
          <div style={{
            fontSize: 11, fontWeight: 500, textTransform: "uppercase",
            letterSpacing: "0.05em", color: "#64748b", marginBottom: 8,
          }}>Children · {childIssues.length}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {childIssues.map((c) => (
              <button key={c.id} onClick={() => onJumpIssue(c.id)} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 10px", borderRadius: 6, textAlign: "left",
                background: "rgb(15 23 42 / 0.6)",
                border: "1px solid #1e293b",
                cursor: "pointer", fontFamily: "inherit",
              }}>
                <span style={{
                  fontSize: 10, fontWeight: 600, color: "#64748b",
                  fontVariantNumeric: "tabular-nums",
                }}>{c.id}</span>
                <TypeBadge type={c.type} compact />
                <span style={{
                  flex: 1, fontSize: 12, color: "#e2e8f0",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>{c.title}</span>
                <span style={{
                  fontSize: 10, color: "#94a3b8", textTransform: "capitalize",
                }}>{c.status.replace("_", " ")}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CommentsTab({ issue }) {
  const comments = commentsFor(issue);
  if (comments.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#475569", fontSize: 13 }}>
        No comments yet.
      </div>
    );
  }
  return (
    <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
      {comments.map((c, i) => (
        <div key={i} style={{
          padding: "10px 12px", borderRadius: 6,
          background: c.author === "danxbot" ? "rgb(30 27 75 / 0.4)" : "rgb(15 23 42 / 0.6)",
          border: `1px solid ${c.author === "danxbot" ? "rgb(99 102 241 / 0.25)" : "#1e293b"}`,
        }}>
          <div style={{
            display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4,
          }}>
            <span style={{
              fontSize: 12, fontWeight: 600,
              color: c.author === "danxbot" ? "#a5b4fc" : "#e2e8f0",
            }}>{c.author}</span>
            <span style={{ fontSize: 11, color: "#64748b" }}>{relativeTime(c.ts)}</span>
          </div>
          <div style={{ fontSize: 13, color: "#cbd5e1", lineHeight: 1.5, textWrap: "pretty" }}>
            {c.text}
          </div>
        </div>
      ))}
    </div>
  );
}

function RetroTab({ issue }) {
  const r = issue.retro;
  if (!r) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#475569", fontSize: 13 }}>
        No retro for this issue.
        <div style={{ marginTop: 6, fontSize: 11 }}>
          Retros are auto-generated when an issue is marked done.
        </div>
      </div>
    );
  }
  const Section = ({ title, items, color }) => items.length > 0 && (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 600, textTransform: "uppercase",
        letterSpacing: "0.05em", color, marginBottom: 6,
      }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18, color: "#cbd5e1", fontSize: 13, lineHeight: 1.6 }}>
        {items.map((x, i) => <li key={i} style={{ textWrap: "pretty" }}>{x}</li>)}
      </ul>
    </div>
  );
  return (
    <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 18 }}>
      <Section title="What went well" items={r.good || []} color="#6ee7b7" />
      <Section title="What didn't" items={r.bad || []} color="#fca5a5" />
      <Section title="Action items" items={r.action_items || []} color="#fcd34d" />
      {r.commits && r.commits.length > 0 && (
        <div>
          <div style={{
            fontSize: 11, fontWeight: 600, textTransform: "uppercase",
            letterSpacing: "0.05em", color: "#94a3b8", marginBottom: 6,
          }}>Commits</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {r.commits.map((c) => (
              <span key={c} style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 11, padding: "2px 8px", borderRadius: 4,
                background: "rgb(15 23 42 / 0.8)", color: "#94a3b8",
                border: "1px solid #1e293b",
              }}>{c}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RawTab({ issue }) {
  // Pseudo-YAML rendering of the issue
  const yaml = useDrawerMemo(() => {
    const lines = [];
    lines.push(`id: ${issue.id}`);
    lines.push(`type: ${issue.type}`);
    lines.push(`status: ${issue.status}`);
    if (issue.parent_id) lines.push(`parent_id: ${issue.parent_id}`);
    if (issue.children && issue.children.length) {
      lines.push(`children:`);
      issue.children.forEach((c) => lines.push(`  - ${c}`));
    }
    lines.push(`title: ${JSON.stringify(issue.title)}`);
    lines.push(`description: |`);
    (issue.description || "").split("\n").forEach((l) => lines.push(`  ${l}`));
    if (issue.ac && issue.ac.length) {
      lines.push(`ac:`);
      issue.ac.forEach((a) => lines.push(`  - { done: ${a.done}, text: ${JSON.stringify(a.text)} }`));
    }
    if (issue.phases && issue.phases.length) {
      lines.push(`phases:`);
      issue.phases.forEach((p) => lines.push(`  - { status: ${p.status}, name: ${JSON.stringify(p.name)} }`));
    }
    if (issue.blocked) {
      lines.push(`blocked:`);
      lines.push(`  reason: ${JSON.stringify(issue.blocked.reason)}`);
      if (issue.blocked.by && issue.blocked.by.length) {
        lines.push(`  by: [${issue.blocked.by.join(", ")}]`);
      }
    }
    lines.push(`triaged: ${issue.triaged}`);
    lines.push(`updatedAt: ${new Date(issue.updatedAt).toISOString()}`);
    return lines.join("\n");
  }, [issue]);
  return (
    <pre style={{
      margin: 0, padding: "16px 20px",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12, color: "#cbd5e1", lineHeight: 1.55,
      background: "#020617",
      whiteSpace: "pre-wrap", wordBreak: "break-word",
    }}>{yaml}</pre>
  );
}

function IssueDrawer({ issue, allIssues, onClose, onJumpIssue, scopedEpicId, onScopeEpic }) {
  const [tab, setTab] = useDrawerState("overview");
  if (!issue) return null;

  const isScoped = scopedEpicId && (issue.id === scopedEpicId || issue.parent_id === scopedEpicId);
  const toggleScope = () => {
    const targetEpic = issue.type === "epic" ? issue.id : issue.parent_id;
    if (!targetEpic) return;
    onScopeEpic(scopedEpicId === targetEpic ? null : targetEpic);
  };

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "comments", label: `Comments${issue.comments_count ? ` · ${issue.comments_count}` : ""}` },
    { id: "retro", label: "Retro", disabled: !issue.has_retro },
    { id: "raw", label: "Raw YAML" },
  ];

  return (
    <>
      {/* Scrim */}
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, background: "rgb(2 6 23 / 0.5)",
        zIndex: 40, animation: "iss-fade 150ms ease-out",
      }} />
      {/* Drawer */}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: "min(560px, 100vw)",
        background: "#0b1220", borderLeft: "1px solid #1e293b",
        zIndex: 50, display: "flex", flexDirection: "column",
        boxShadow: "-12px 0 32px rgb(0 0 0 / 0.4)",
        animation: "iss-slide 200ms cubic-bezier(.2,.8,.2,1)",
      }}>
        <DrawerHeader
          issue={issue}
          onClose={onClose}
          onJumpEpic={onJumpIssue}
          scoped={isScoped && scopedEpicId}
          onToggleScope={toggleScope}
        />
        {/* Tabs */}
        <div style={{
          display: "flex", gap: 2, padding: "0 20px",
          borderBottom: "1px solid #1e293b",
        }}>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => !t.disabled && setTab(t.id)}
              disabled={t.disabled}
              style={{
                padding: "10px 14px", fontSize: 12, fontWeight: 500,
                background: "none", border: 0, fontFamily: "inherit",
                cursor: t.disabled ? "not-allowed" : "pointer",
                color: t.disabled ? "#475569" : (tab === t.id ? "#a5b4fc" : "#94a3b8"),
                borderBottom: `2px solid ${tab === t.id ? "#6366f1" : "transparent"}`,
                marginBottom: -1,
                opacity: t.disabled ? 0.5 : 1,
              }}
            >{t.label}</button>
          ))}
        </div>
        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {tab === "overview" && <OverviewTab issue={issue} allIssues={allIssues} onJumpIssue={onJumpIssue} />}
          {tab === "comments" && <CommentsTab issue={issue} />}
          {tab === "retro" && <RetroTab issue={issue} />}
          {tab === "raw" && <RawTab issue={issue} />}
        </div>
      </div>
      <style>{`
        @keyframes iss-slide { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes iss-fade { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
    </>
  );
}

Object.assign(window, { IssueDrawer });

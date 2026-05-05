import type { IssueAcItem } from "../../types";

export interface AcCounts {
  done: number;
  total: number;
}

export function acCounts(ac: IssueAcItem[]): AcCounts {
  const total = ac.length;
  let done = 0;
  for (const a of ac) if (a.checked) done++;
  return { done, total };
}

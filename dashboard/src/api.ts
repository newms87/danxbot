export interface RepoInfo {
  name: string;
  url: string;
}

export async function fetchRepos(): Promise<RepoInfo[]> {
  const res = await fetch("/api/repos");
  return res.json();
}

export interface ParseYamlBatchInput {
  texts: string[];
}

export type ParseYamlBatchEntry =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

declare function parseYamlBatchTask(
  input: ParseYamlBatchInput,
): ParseYamlBatchEntry[];

export default parseYamlBatchTask;

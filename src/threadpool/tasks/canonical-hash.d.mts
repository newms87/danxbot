export interface CanonicalHashInput {
  value: unknown;
}

export interface CanonicalHashOutput {
  canonical: string;
  hash: string;
}

declare function canonicalHashTask(input: CanonicalHashInput): CanonicalHashOutput;

export default canonicalHashTask;

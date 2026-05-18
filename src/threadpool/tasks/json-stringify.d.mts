export interface JsonStringifyInput {
  value: unknown;
}

declare function jsonStringifyTask(input: JsonStringifyInput): string;

export default jsonStringifyTask;

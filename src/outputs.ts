import { decodeMultiStream } from "@msgpack/msgpack";
import { client } from "./api.js";

type Dict = Record<string, any>;

const OUTPUT_REGEX = /^(?<path>[\w.-]+?)(\.(?<result>(stdout|stderr|os_error)))?$/;

export function runTestFilter(filterTests: string[], tests: Dict[]): Dict[] {
  const selected: Dict[] = [];
  for (const test of tests) {
    const currentPath = String(test.path).replace(/:/g, ".");
    for (const filter of filterTests) {
      const m = OUTPUT_REGEX.exec(filter.replace(/:/g, "."));
      if (m && currentPath === m.groups!.path) {
        const result = m.groups!.result;
        if (result) {
          test.output = { [result]: test.output[result] };
          test.filtered_result = result;
        }
        selected.push(test);
      }
    }
  }
  return selected;
}

const decoder = new TextDecoder();

function decodeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return decoder.decode(value);
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeValue(v)]));
  }
  return value;
}

/** Fetch and decode the msgpack execution outputs (bytes become strings). */
export async function loadExecutionOutputs(executionId: number): Promise<Dict[]> {
  const response = await client.stream(`/executions/${executionId}/output`);
  const outputs: Dict[] = [];
  if (!response.body) return outputs;
  for await (const item of decodeMultiStream(response.body)) {
    const isEmpty =
      item === null || item === undefined || (typeof item === "object" && Object.keys(item).length === 0);
    if (!isEmpty) outputs.push(decodeValue(item) as Dict);
  }
  return outputs;
}

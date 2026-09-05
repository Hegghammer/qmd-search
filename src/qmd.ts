export const QMD_MODES = ["query", "search", "vsearch"] as const;

export type QmdMode = (typeof QMD_MODES)[number];
export type VectorSearchMode = "single" | "expanded";

interface QmdArguments {
  query: string;
  mode: QmdMode;
  vectorSearchMode: VectorSearchMode;
  collections: string[];
  index: string;
  maxResults: number;
}

interface ParsedQmdOutput {
  items: unknown[];
  notice?: string;
}

export function buildQmdArgs(options: QmdArguments): string[] {
  const singleVector = options.mode === "vsearch" && options.vectorSearchMode === "single";
  const command = singleVector ? "query" : options.mode;
  const query = singleVector
    ? `vec: ${options.query.replace(/[\r\n]+/g, " ")}`
    : options.query;
  const args = [
    ...(options.index ? ["--index", options.index] : []),
    command,
    ...(singleVector ? ["--no-rerank"] : []),
    "--format",
    "json",
    "--full-path",
    "-n",
    String(options.maxResults),
  ];

  for (const collection of options.collections) {
    args.push("--collection", collection);
  }

  // QMD uses util.parseArgs, so terminate options before arbitrary user input.
  args.push("--", query);
  return args;
}

export function parseQmdOutput(stdout: string): ParsedQmdOutput {
  const output = stdout.trim();
  if (!output) {
    return { items: [] };
  }

  try {
    return { items: parseJsonArray(output) };
  } catch (initialError) {
    const arrayStarts = [...output.matchAll(/^\[/gm)].map((match) => match.index ?? 0);
    for (let index = arrayStarts.length - 1; index >= 0; index -= 1) {
      const start = arrayStarts[index];
      if (start === 0) {
        continue;
      }

      try {
        return {
          items: parseJsonArray(output.slice(start)),
          notice: output.slice(0, start).trim() || undefined,
        };
      } catch {
        // Continue looking for the final top-level JSON array.
      }
    }

    throw initialError;
  }
}

function parseJsonArray(value: string): unknown[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("QMD returned JSON in an unexpected format.");
  }
  return parsed;
}

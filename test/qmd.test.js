const assert = require("node:assert/strict");
const test = require("node:test");
const { buildQmdArgs, parseQmdOutput } = require("../dist/qmd.js");

test("buildQmdArgs terminates options before a leading-dash query", () => {
  assert.deepEqual(buildQmdArgs({
    query: "--version",
    mode: "search",
    vectorSearchMode: "single",
    collections: ["notes"],
    index: "",
    maxResults: 20,
  }), [
    "search",
    "--format", "json",
    "--full-path",
    "-n", "20",
    "--collection", "notes",
    "--", "--version",
  ]);
});

test("buildQmdArgs creates a single vector-only query", () => {
  assert.deepEqual(buildQmdArgs({
    query: "semantic\nsearch",
    mode: "vsearch",
    vectorSearchMode: "single",
    collections: [],
    index: "work",
    maxResults: 5,
  }), [
    "--index", "work",
    "query",
    "--no-rerank",
    "--format", "json",
    "--full-path",
    "-n", "5",
    "--", "vec: semantic search",
  ]);
});

test("buildQmdArgs retains expanded vector search", () => {
  const args = buildQmdArgs({
    query: "semantic search",
    mode: "vsearch",
    vectorSearchMode: "expanded",
    collections: [],
    index: "",
    maxResults: 5,
  });

  assert.equal(args[0], "vsearch");
  assert.equal(args.includes("--no-rerank"), false);
});

test("parseQmdOutput reads clean JSON arrays", () => {
  assert.deepEqual(parseQmdOutput('[{"file":"note.md"}]'), {
    items: [{ file: "note.md" }],
  });
});

test("parseQmdOutput preserves diagnostics before the final JSON array", () => {
  assert.deepEqual(parseQmdOutput('Trust required\n[\n  {"file":"note.md"}\n]\n'), {
    items: [{ file: "note.md" }],
    notice: "Trust required",
  });
});

test("parseQmdOutput rejects non-array JSON", () => {
  assert.throws(() => parseQmdOutput('{"file":"note.md"}'), /unexpected format/);
});

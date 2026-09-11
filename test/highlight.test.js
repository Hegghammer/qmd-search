const assert = require("node:assert/strict");
const test = require("node:test");
const { findKeywordHighlights } = require("../dist/highlight.js");

function highlightedText(text, query, mode) {
  return findKeywordHighlights(text, query, mode).map((range) => text.slice(range.start, range.end));
}

test("keyword highlighting follows prefix, phrase, and exclusion syntax", () => {
  const text = "Machine learning improves performance with performant tools, not legacy systems.";

  assert.deepEqual(highlightedText(text, '"machine learning" perf -legacy', "search"), [
    "Machine",
    "learning",
    "performance",
    "performant",
  ]);
});

test("quoted keyword terms match whole words while bare terms match prefixes", () => {
  const text = "perf performance";

  assert.deepEqual(highlightedText(text, '"perf"', "search"), ["perf"]);
  assert.deepEqual(highlightedText(text, "perf", "search"), ["perf", "performance"]);
});

test("hyphenated keyword terms highlight their exact component words", () => {
  const text = "A multi-agent system uses multiple agents and GPT-4.";

  assert.deepEqual(highlightedText(text, "multi-agent gpt-4", "search"), ["multi", "agent", "GPT", "4"]);
});

test("typed hybrid queries only highlight lexical terms", () => {
  const text = "Authentication for a secure cloud can replace legacy login systems.";
  const query = "intent: authentication guidance\nlex: secure cloud -legacy\nvec: login systems";

  assert.deepEqual(highlightedText(text, query, "query"), ["secure", "cloud"]);
});

test("untyped hybrid queries highlight their natural-language words", () => {
  const text = "Secure cloud design";

  assert.deepEqual(highlightedText(text, "secure - cloud", "query"), ["Secure", "cloud"]);
});

test("explicit expand queries highlight their natural-language words", () => {
  const text = "Error handling follows established best practices.";

  assert.deepEqual(highlightedText(text, "expand: error handling best practices", "query"), [
    "Error",
    "handling",
    "best",
    "practices",
  ]);
});

test("keyword highlighting ignores diacritics like QMD", () => {
  assert.deepEqual(highlightedText("Visit the café", "cafe", "search"), ["café"]);
});

test("vector search does not produce keyword highlights", () => {
  assert.deepEqual(findKeywordHighlights("semantic search", "semantic", "vsearch"), []);
});

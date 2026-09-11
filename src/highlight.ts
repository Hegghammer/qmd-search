import type { QmdMode } from "./qmd";

export interface HighlightRange {
  start: number;
  end: number;
}

interface HighlightTerm {
  value: string;
  prefix: boolean;
}

const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const TYPED_QUERY_PATTERN = /^\s*(lex|vec|hyde|intent|expand)\s*:(.*)$/i;

export function findKeywordHighlights(text: string, query: string, mode: QmdMode): HighlightRange[] {
  if (!text || mode === "vsearch") {
    return [];
  }

  const terms = mode === "search" ? extractLexTerms(query) : extractHybridTerms(query);
  if (!terms.length) {
    return [];
  }

  const ranges: HighlightRange[] = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    const word = normalize(match[0]);
    if (terms.some((term) => term.prefix ? word.startsWith(term.value) : word === term.value)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges;
}

function extractHybridTerms(query: string): HighlightTerm[] {
  const lines = query.split(/\r?\n/).filter((line) => line.trim());
  const typedLines = lines.map((line) => line.match(TYPED_QUERY_PATTERN));
  if (lines.length === 1 && typedLines[0]?.[1].toLowerCase() === "expand") {
    return deduplicateTerms(extractWords(typedLines[0][2]).map((value) => ({ value, prefix: true })));
  }
  if (typedLines.some(Boolean)) {
    return deduplicateTerms(typedLines.flatMap((match) => {
      return match?.[1].toLowerCase() === "lex" ? extractLexTerms(match[2]) : [];
    }));
  }

  return deduplicateTerms(extractWords(query).map((value) => ({ value, prefix: true })));
}

function extractLexTerms(query: string): HighlightTerm[] {
  const tokens = query.match(/-?"[^"]*"|-?\S+/g) ?? [];
  const terms: HighlightTerm[] = [];

  for (const token of tokens) {
    if (token.startsWith("-")) {
      continue;
    }
    if (token.startsWith('"') && token.endsWith('"')) {
      terms.push(...extractWords(token.slice(1, -1)).map((value) => ({ value, prefix: false })));
      continue;
    }
    if (token.includes("-")) {
      terms.push(...extractWords(token).map((value) => ({ value, prefix: false })));
      continue;
    }

    const value = normalize(token.replace(/[^\p{L}\p{N}'’]/gu, ""));
    if (value) {
      terms.push({ value, prefix: true });
    }
  }

  return deduplicateTerms(terms);
}

function extractWords(value: string): string[] {
  return Array.from(value.matchAll(WORD_PATTERN), (match) => normalize(match[0]));
}

function normalize(value: string): string {
  return value
    .replace(/’/g, "'")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

function deduplicateTerms(terms: HighlightTerm[]): HighlightTerm[] {
  const unique = new Map<string, HighlightTerm>();
  for (const term of terms) {
    const existing = unique.get(term.value);
    if (!existing || term.prefix) {
      unique.set(term.value, term);
    }
  }
  return [...unique.values()];
}

// Fuzzy matching for the account search box: ordered-subsequence scoring plus
// a Dice coefficient over bigrams, so "nasa bot" finds nasa-x-bot without an
// exact substring match.
import type { AccountMapping } from '../types';

export function normalizeSearchValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9@#._\-\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeSearchValue(value: string): string[] {
  if (!value) {
    return [];
  }
  return value.split(' ').filter((token) => token.length > 0);
}

export function orderedSubsequenceScore(query: string, candidate: string): number {
  if (!query || !candidate) {
    return 0;
  }

  let matched = 0;
  let searchIndex = 0;
  for (const char of query) {
    const foundIndex = candidate.indexOf(char, searchIndex);
    if (foundIndex === -1) {
      continue;
    }
    matched += 1;
    searchIndex = foundIndex + 1;
  }

  return matched / query.length;
}

export function buildBigrams(value: string): Set<string> {
  const result = new Set<string>();
  if (value.length < 2) {
    if (value.length === 1) {
      result.add(value);
    }
    return result;
  }
  for (let i = 0; i < value.length - 1; i += 1) {
    result.add(value.slice(i, i + 2));
  }
  return result;
}

export function diceCoefficient(a: string, b: string): number {
  const aBigrams = buildBigrams(a);
  const bBigrams = buildBigrams(b);
  if (aBigrams.size === 0 || bBigrams.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const gram of aBigrams) {
    if (bBigrams.has(gram)) {
      overlap += 1;
    }
  }
  return (2 * overlap) / (aBigrams.size + bBigrams.size);
}

export function scoreSearchField(query: string, tokens: string[], candidateValue?: string): number {
  const candidate = normalizeSearchValue(candidateValue || '');
  if (!query || !candidate) {
    return 0;
  }

  let score = 0;
  if (candidate === query) {
    score += 170;
  } else if (candidate.startsWith(query)) {
    score += 138;
  } else if (candidate.includes(query)) {
    score += 108;
  }

  let matchedTokens = 0;
  for (const token of tokens) {
    if (candidate.includes(token)) {
      matchedTokens += 1;
      score += token.length >= 4 ? 18 : 12;
    }
  }
  if (tokens.length > 0) {
    score += (matchedTokens / tokens.length) * 46;
  }

  score += orderedSubsequenceScore(query, candidate) * 45;
  score += diceCoefficient(query, candidate) * 52;
  return score;
}

export function scoreAccountMapping(mapping: AccountMapping, query: string, tokens: string[]): number {
  const usernameScores = mapping.twitterUsernames.map((username) => scoreSearchField(query, tokens, username) * 1.24);
  const bestUsernameScore = usernameScores.length > 0 ? Math.max(...usernameScores) : 0;
  const identifierScore = scoreSearchField(query, tokens, mapping.bskyIdentifier) * 1.2;
  const ownerScore = scoreSearchField(query, tokens, mapping.owner) * 0.92;
  const groupScore = scoreSearchField(query, tokens, mapping.groupName) * 0.72;
  const combined = [bestUsernameScore, identifierScore, ownerScore, groupScore];
  const maxScore = Math.max(...combined);
  return maxScore + (combined.reduce((total, value) => total + value, 0) - maxScore) * 0.24;
}

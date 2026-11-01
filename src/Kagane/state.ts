/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 kittycatgit */

import { SourceStateManager } from "@paperback/types";

import {
  AGE_RATINGS,
  CHALLENGE_HOST_KEY,
  CONTENT_LANGUAGES_KEY,
  CONTENT_RATINGS_KEY,
  CUSTOM_HIDDEN_TAGS_KEY,
  DEFAULT_RATINGS,
  DOMAIN_AT_KEY,
  DOMAIN_KEY,
  DOMAIN_OVERRIDE_KEY,
  EXCLUDED_GENRES_KEY,
  HIDDEN_TAG_CATEGORIES_KEY,
  LEGACY_RATINGS,
  SHOW_DISTURBING_KEY,
  SHOW_PORNOGRAPHIC_KEY,
  SHOW_SOURCE_KEY,
  SOURCE_DISPLAY_MODES,
  SOURCE_DISPLAY_MODE_KEY,
  TAG_MATCH_ALL_KEY,
} from "./models";
import { HIDDEN_TAG_CATEGORIES } from "./tags";

// Created on first use: the bundler loads this module to read SourceInfo, and
// App does not exist yet at import time.
let manager: SourceStateManager | undefined;

export function stateManager(): SourceStateManager {
  manager ??= App.createSourceStateManager();

  return manager;
}

async function readArray(key: string, fallback: string[] = []): Promise<string[]> {
  const value = (await stateManager().retrieve(key)) as unknown;

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  return typeof value === "string" && value ? [value] : fallback;
}

async function readBoolean(key: string, fallback: boolean): Promise<boolean> {
  const value = (await stateManager().retrieve(key)) as unknown;

  return typeof value === "boolean" ? value : fallback;
}

function normalizeDomain(value: unknown): string {
  const trimmed = String(value ?? "").trim();

  if (!trimmed) {
    return "";
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  return withScheme.replace(/\/+$/, "");
}

export async function getDomainOverride(): Promise<string> {
  return normalizeDomain(await stateManager().retrieve(DOMAIN_OVERRIDE_KEY));
}

export async function setDomainOverride(value: unknown): Promise<void> {
  await stateManager().store(DOMAIN_OVERRIDE_KEY, normalizeDomain(value));
}

export async function getCachedDomain(): Promise<{ domain: string; at: number } | undefined> {
  const domain = normalizeDomain(await stateManager().retrieve(DOMAIN_KEY));
  const at = Number((await stateManager().retrieve(DOMAIN_AT_KEY)) ?? 0);

  return domain && at > 0 ? { domain, at } : undefined;
}

export async function setCachedDomain(domain: string): Promise<void> {
  await stateManager().store(DOMAIN_KEY, normalizeDomain(domain));
  await stateManager().store(DOMAIN_AT_KEY, Date.now());
}

export async function clearCachedDomain(): Promise<void> {
  await stateManager().store(DOMAIN_KEY, "");
  await stateManager().store(DOMAIN_AT_KEY, 0);
}

export async function getChallengeHost(): Promise<string> {
  return normalizeDomain(await stateManager().retrieve(CHALLENGE_HOST_KEY));
}

export async function setChallengeHost(origin: string): Promise<void> {
  await stateManager().store(CHALLENGE_HOST_KEY, normalizeDomain(origin));
}

// Older builds stored the site's previous rating names, in a list or as one
// ceiling; both fold onto the age_rating ladder so nothing a reader could see
// before disappears.
export async function getContentRatings(): Promise<string[]> {
  const value = (await stateManager().retrieve(CONTENT_RATINGS_KEY)) as unknown;
  const stored = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string" && value
      ? [value]
      : [];

  const valid = new Set<string>(AGE_RATINGS.map((rating) => rating.id));
  const mapped = stored.map((entry) => LEGACY_RATINGS[entry.toLowerCase()] ?? entry);
  const list = [...new Set(mapped.filter((entry) => valid.has(entry)))];

  if (typeof value === "string" && list.length === 1) {
    const index = AGE_RATINGS.findIndex((rating) => rating.id === list[0]);

    return AGE_RATINGS.slice(0, index + 1).map((rating) => rating.id);
  }

  return list.length > 0 ? list : DEFAULT_RATINGS;
}

export async function getShowPornographic(): Promise<boolean> {
  return readBoolean(SHOW_PORNOGRAPHIC_KEY, false);
}

export async function getShowDisturbing(): Promise<boolean> {
  return readBoolean(SHOW_DISTURBING_KEY, false);
}

export async function getSourceDisplayMode(): Promise<string> {
  const value = (await stateManager().retrieve(SOURCE_DISPLAY_MODE_KEY)) as unknown;
  const mode = Array.isArray(value) ? value[0] : value;

  return SOURCE_DISPLAY_MODES.some((entry) => entry.id === mode) ? (mode as string) : "all";
}

export async function getSourceTypes(): Promise<string[]> {
  const mode = await getSourceDisplayMode();

  return [...(SOURCE_DISPLAY_MODES.find((entry) => entry.id === mode)?.types ?? [])];
}

export async function getContentLanguages(): Promise<string[]> {
  return readArray(CONTENT_LANGUAGES_KEY, ["en"]);
}

// Genre ids are the taxonomy UUIDs, so they drop straight into the request.
export async function getExcludedGenres(): Promise<string[]> {
  return readArray(EXCLUDED_GENRES_KEY);
}

export async function getHiddenTagIds(): Promise<string[]> {
  const selected = new Set(await readArray(HIDDEN_TAG_CATEGORIES_KEY));

  return HIDDEN_TAG_CATEGORIES.filter((category) => selected.has(category.id)).flatMap(
    (category) => category.tagIds,
  );
}

export async function getCustomHiddenTags(): Promise<string[]> {
  return readArray(CUSTOM_HIDDEN_TAGS_KEY);
}

export async function getShowSource(): Promise<boolean> {
  return readBoolean(SHOW_SOURCE_KEY, false);
}

export async function getTagMatchAll(): Promise<boolean> {
  return readBoolean(TAG_MATCH_ALL_KEY, false);
}

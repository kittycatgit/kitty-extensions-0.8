/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 kittycatgit */

import { SourceStateManager } from "@paperback/types";

import {
  ADULT_MODES,
  ADULT_MODE_KEY,
  CHALLENGE_HOST_KEY,
  LANGUAGE_KEY,
  LANGUAGE_OPTIONS,
  TAG_MATCH_ALL_KEY,
} from "./models";

// Created on first use: the bundler loads this module to read SourceInfo, and
// App does not exist yet at import time.
let manager: SourceStateManager | undefined;

export function stateManager(): SourceStateManager {
  manager ??= App.createSourceStateManager();

  return manager;
}

async function readArray(key: string, fallback: string[]): Promise<string[]> {
  const value = (await stateManager().retrieve(key)) as unknown;

  if (Array.isArray(value)) {
    const list = value.filter(
      (entry): entry is string => typeof entry === "string" && entry !== "",
    );

    return list.length > 0 ? list : fallback;
  }

  return typeof value === "string" && value ? [value] : fallback;
}

// The site's own content switch (all / no_18 / only_18); it is sent with every
// listing and search request.
export async function getAdultMode(): Promise<string> {
  const value = (await stateManager().retrieve(ADULT_MODE_KEY)) as unknown;
  const mode = Array.isArray(value) ? value[0] : value;

  return ADULT_MODES.some((entry) => entry.id === mode) ? (mode as string) : "all";
}

export async function getLanguageSetting(): Promise<string[]> {
  return readArray(LANGUAGE_KEY, ["all"]);
}

export async function setLanguageSetting(value: unknown): Promise<void> {
  const list = (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is string => typeof entry === "string" && entry !== "",
  );
  const current = await getLanguageSetting();

  // "all" just picked clears the specific languages; a specific language picked
  // while "all" was active drops "all".
  const next =
    list.length === 0
      ? ["all"]
      : list.includes("all") && !current.includes("all")
        ? ["all"]
        : list.length > 1 && list.includes("all")
          ? list.filter((entry) => entry !== "all")
          : list;

  await stateManager().store(LANGUAGE_KEY, next);
}

// A chapter passes when "all" is selected, or its language code matches a
// selected id, or (fallback) its display name matches a selected option's label.
export function isLanguageAllowed(setting: string[], code: string, name?: string): boolean {
  if (setting.includes("all")) {
    return true;
  }

  const lang = code.trim().toLowerCase();
  if (lang && setting.includes(lang)) {
    return true;
  }

  if (name) {
    const printed = name.trim().toLowerCase();

    return setting.some(
      (id) => LANGUAGE_OPTIONS.find((option) => option.id === id)?.title.toLowerCase() === printed,
    );
  }

  return false;
}

export async function getTagMatchAll(): Promise<boolean> {
  const value = (await stateManager().retrieve(TAG_MATCH_ALL_KEY)) as unknown;

  return typeof value === "boolean" ? value : true;
}

export async function getChallengeHost(): Promise<string> {
  const value = (await stateManager().retrieve(CHALLENGE_HOST_KEY)) as unknown;

  return typeof value === "string" ? value : "";
}

export async function setChallengeHost(origin: string): Promise<void> {
  await stateManager().store(CHALLENGE_HOST_KEY, origin.replace(/\/+$/, ""));
}

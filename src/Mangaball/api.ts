/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 kittycatgit */

import { RequestManager, Response } from "@paperback/types";

import {
  API,
  FALLBACK_TAGS,
  TAGS_CACHE_DATE_KEY,
  TAGS_CACHE_KEY,
  TAGS_TTL_MS,
  TAG_GROUPS,
  type ApiTag,
  type TagGroup,
} from "./models";
import { setChallengeHost, stateManager } from "./state";

export function originOf(url: string): string {
  return /^(https?:\/\/[^/?#]+)/i.exec(url)?.[1] ?? "";
}

export function isCloudflareChallenge(response: Response): boolean {
  if (response.status !== 403 && response.status !== 503) {
    return false;
  }

  const headers = response.headers ?? {};
  const mitigated = String(headers["cf-mitigated"] ?? headers["Cf-Mitigated"] ?? "");

  return (
    mitigated.toLowerCase() === "challenge" ||
    /just a moment|cf-chl|challenge-platform|attention required/i.test(response.data ?? "")
  );
}

export class MangaballApi {
  constructor(private readonly requestManager: RequestManager) {}

  private tags?: { at: number; value: TagGroup[] };

  // The home page asks ten rows at once; without holding the in-flight promise
  // each of them starts its own copy of the tag request.
  private pendingTags?: Promise<TagGroup[]>;

  async getJson<T>(path: string, query = ""): Promise<T> {
    const url = `${API}/${path}${query ? `?${query}` : ""}`;
    const response = await this.requestManager.schedule(
      App.createRequest({ url, method: "GET" }),
      1,
    );
    const raw = typeof response.data === "string" ? response.data : String(response.data ?? "");

    if (isCloudflareChallenge(response)) {
      await setChallengeHost(originOf(url));
      throw new Error("Bot verification detected, bypass it to continue!");
    }

    if (response.status !== 200) {
      throw new Error(`Mangaball answered ${response.status} for ${url}: ${raw.slice(0, 120)}`);
    }

    return JSON.parse(raw) as T;
  }

  async getTagGroups(): Promise<TagGroup[]> {
    if (this.tags && Date.now() - this.tags.at < TAGS_TTL_MS) {
      return this.tags.value;
    }

    this.pendingTags ??= this.loadTagGroups().finally(() => {
      this.pendingTags = undefined;
    });

    return this.pendingTags;
  }

  private async loadTagGroups(): Promise<TagGroup[]> {
    const cached = await this.readCachedTags();

    if (cached) {
      this.tags = { at: Date.now(), value: cached };

      return cached;
    }

    try {
      const response = await this.getJson<{ data?: Record<string, ApiTag[]> }>("tag/get-grouped");
      const groups: TagGroup[] = [];

      for (const group of TAG_GROUPS) {
        const tags = (response.data?.[group.id] ?? [])
          .filter((tag) => tag.id && tag.name)
          .map((tag) => ({ id: tag.id, title: tag.name }));

        if (tags.length > 0) {
          groups.push({ id: group.id, title: group.title, tags });
        }
      }

      if (groups.length === 0) {
        throw new Error("The tag list came back empty");
      }

      this.tags = { at: Date.now(), value: groups };

      // Persisting is best-effort: a storage failure after a good fetch must
      // not lose the tags the caller is waiting for.
      try {
        await stateManager().store(TAGS_CACHE_KEY, JSON.stringify(groups));
        await stateManager().store(TAGS_CACHE_DATE_KEY, Date.now());
      } catch {
        // The memory cache still serves this session.
      }

      return groups;
    } catch {
      // The picker is the only thing that needs these, and the ids are stable,
      // so a stale list beats an empty filter sheet.
      return this.tags?.value ?? FALLBACK_TAGS;
    }
  }

  private async readCachedTags(): Promise<TagGroup[] | undefined> {
    try {
      const at = Number((await stateManager().retrieve(TAGS_CACHE_DATE_KEY)) ?? 0);
      const raw = await stateManager().retrieve(TAGS_CACHE_KEY);

      if (typeof raw !== "string" || Date.now() - at > TAGS_TTL_MS) {
        return undefined;
      }

      const parsed = JSON.parse(raw) as TagGroup[];

      return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  // Fire-and-forget: pulls the tag list in behind the painted rows so the
  // filter sheet opens without a wait.
  warm(): void {
    void this.getTagGroups().catch(() => undefined);
  }
}

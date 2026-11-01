/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 kittycatgit */

import { RequestManager, Response } from "@paperback/types";

import {
  DEFAULT_DOMAIN,
  DOMAIN_TTL_MS,
  INTEGRITY_KEY,
  MIRRORS_URL,
  TAGS_CACHE_DATE_KEY,
  TAGS_CACHE_KEY,
  type ChallengeDto,
  type GenreDto,
  type IntegrityDto,
  type SourceDto,
  type TagDto,
} from "./models";
import {
  clearCachedDomain,
  getCachedDomain,
  getDomainOverride,
  setCachedDomain,
  setChallengeHost,
  stateManager,
} from "./state";

const TAXONOMY_TTL_MS = 24 * 60 * 60 * 1000;

interface Taxonomy {
  genres: GenreDto[];
  sources: SourceDto[];
}

interface Integrity {
  domain: string;
  token: string;
  exp: number;
}

export class DomainError extends Error {}

export function isCloudflareChallenge(response: Response): boolean {
  if (response.status !== 403 && response.status !== 503) {
    return false;
  }

  const headers = response.headers ?? {};
  const mitigated = String(headers["cf-mitigated"] ?? headers["Cf-Mitigated"] ?? "");

  return (
    mitigated.toLowerCase() === "challenge" ||
    /just a moment|cf-chl|challenge-platform/i.test(response.data ?? "")
  );
}

export function originOf(url: string): string {
  const match = /^(https?:\/\/[^/?#]+)/i.exec(url);

  return match?.[1] ?? "";
}

// The site changes domain every few weeks and kagane.org lists the live one,
// so every URL is built from a resolved domain rather than a constant.
export function mirrorsFrom(html: string): string[] {
  const found: string[] = [];
  const pattern = /<a\b[^>]*\bhref="(https:\/\/kagane\.[a-z]+)\/?"/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    const host = (match[1] ?? "").toLowerCase();

    if (host && host !== MIRRORS_URL.replace(/\/$/, "") && !found.includes(host)) {
      found.push(host);
    }
  }

  return found;
}

export class KaganeApi {
  constructor(private readonly requestManager: RequestManager) {}

  private domainInMemory?: { domain: string; at: number };

  private pendingDomain?: Promise<string>;

  private taxonomy?: { at: number; value: Taxonomy };

  private tags?: { at: number; value: TagDto[] };

  // The home page asks several rows at once; without holding the in-flight
  // promise each of them starts its own copy of every shared request.
  private pendingTaxonomy?: Promise<Taxonomy>;

  private pendingTags?: Promise<TagDto[]>;

  private integrity?: Integrity;

  // What the interceptor can use without awaiting anything.
  get knownDomain(): string {
    return this.domainInMemory?.domain ?? "";
  }

  async domain(): Promise<string> {
    const override = await getDomainOverride();
    if (override) {
      return override;
    }

    if (this.domainInMemory && Date.now() - this.domainInMemory.at < DOMAIN_TTL_MS) {
      return this.domainInMemory.domain;
    }

    const cached = await getCachedDomain();
    if (cached && Date.now() - cached.at < DOMAIN_TTL_MS) {
      this.domainInMemory = cached;
      return cached.domain;
    }

    return this.resolveDomain();
  }

  async resolveDomain(): Promise<string> {
    this.pendingDomain ??= this.loadDomain().finally(() => {
      this.pendingDomain = undefined;
    });

    return this.pendingDomain;
  }

  private async loadDomain(): Promise<string> {
    const response = await this.requestManager.schedule(
      App.createRequest({ url: MIRRORS_URL, method: "GET" }),
      1,
    );

    if (isCloudflareChallenge(response)) {
      await setChallengeHost(MIRRORS_URL);
      throw new DomainError(`Cloudflare is challenging ${MIRRORS_URL}; complete it and retry.`);
    }

    if (response.status !== 200) {
      throw new DomainError(`The mirrors page ${MIRRORS_URL} answered ${response.status}.`);
    }

    const mirrors = mirrorsFrom(response.data ?? "");
    const domain = mirrors[0];

    if (!domain) {
      throw new DomainError(`No mirror is listed on ${MIRRORS_URL}.`);
    }

    this.domainInMemory = { domain, at: Date.now() };
    await setCachedDomain(domain);

    return domain;
  }

  async forgetDomain(): Promise<void> {
    this.domainInMemory = undefined;
    this.integrity = undefined;
    await clearCachedDomain();
  }

  // The domain settings row needs something to print before anything ran.
  async displayDomain(): Promise<string> {
    const override = await getDomainOverride();

    return override || this.knownDomain || (await getCachedDomain())?.domain || DEFAULT_DOMAIN;
  }

  async apiUrl(path: string): Promise<string> {
    return `${await this.domain()}/api/v2${path}`;
  }

  async fetchJSON<T>(
    path: string,
    init?: { method?: string; body?: string; headers?: Record<string, string>; absolute?: boolean },
  ): Promise<T> {
    const url = init?.absolute ? path : await this.apiUrl(path);
    const response = await this.send(url, init);
    const raw = typeof response.data === "string" ? response.data : String(response.data ?? "");

    if (response.status !== 200) {
      throw new Error(`Kagane answered ${response.status} for ${url}: ${raw.slice(0, 120)}`);
    }

    return JSON.parse(raw) as T;
  }

  // A mirror that stops answering is the signal the site moved again: resolve
  // once more and repeat the call on the new domain, otherwise give up.
  private async send(
    url: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
  ): Promise<Response> {
    const origin = originOf(url);
    const onMirror = origin !== "" && origin === this.knownDomain && !(await getDomainOverride());

    let response: Response;
    try {
      response = await this.schedule(url, init);
    } catch (error) {
      if (!onMirror) {
        throw error;
      }

      const next = await this.renewDomain(origin);
      if (!next) {
        throw error;
      }

      return this.schedule(url.replace(origin, next), init);
    }

    if (isCloudflareChallenge(response)) {
      await setChallengeHost(origin);
      return response;
    }

    if (onMirror && response.status >= 500) {
      const next = await this.renewDomain(origin);
      if (next) {
        return this.schedule(url.replace(origin, next), init);
      }
    }

    return response;
  }

  private schedule(
    url: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
  ): Promise<Response> {
    return this.requestManager.schedule(
      App.createRequest({
        url,
        method: init?.method ?? "GET",
        ...(init?.headers ? { headers: init.headers } : {}),
        ...(init?.body !== undefined ? { data: init.body } : {}),
      }),
      1,
    );
  }

  private async renewDomain(failed: string): Promise<string | undefined> {
    await this.forgetDomain();
    const next = await this.resolveDomain();

    return next !== failed ? next : undefined;
  }

  // The site mints these itself with no payload; each lasts about five minutes
  // and names the domain it was minted on, so a domain change discards it.
  private async integrityToken(force = false): Promise<string> {
    const domain = await this.domain();
    const fresh = (entry?: Integrity) =>
      !!entry && entry.domain === domain && entry.exp > Date.now() + 15_000;

    if (!force && fresh(this.integrity)) {
      return this.integrity!.token;
    }

    if (!force) {
      const stored = (await stateManager().retrieve(INTEGRITY_KEY)) as Integrity | undefined;

      if (stored && typeof stored === "object" && fresh(stored)) {
        this.integrity = stored;
        return stored.token;
      }
    }

    const issued = await this.fetchJSON<IntegrityDto>(`${domain}/api/integrity`, {
      absolute: true,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    this.integrity = { domain, token: issued.token, exp: issued.exp * 1000 };
    await stateManager().store(INTEGRITY_KEY, this.integrity);

    return issued.token;
  }

  async challenge(bookId: string): Promise<ChallengeDto> {
    const request = async (token: string) =>
      this.fetchJSON<ChallengeDto>(`/books/${bookId}?intent=Read`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-integrity-token": token },
        body: "{}",
      });

    try {
      return await request(await this.integrityToken());
    } catch {
      // A token that expired mid-session reads as a plain 401; one retry with a
      // fresh one is the difference between a working chapter and a dead one.
      return request(await this.integrityToken(true));
    }
  }

  async getTaxonomy(): Promise<Taxonomy> {
    if (this.taxonomy && Date.now() - this.taxonomy.at < TAXONOMY_TTL_MS) {
      return this.taxonomy.value;
    }

    this.pendingTaxonomy ??= this.loadTaxonomy().finally(() => {
      this.pendingTaxonomy = undefined;
    });

    return this.pendingTaxonomy;
  }

  private async loadTaxonomy(): Promise<Taxonomy> {
    const [genres, sources] = await Promise.all([
      this.fetchJSON<GenreDto[]>("/genres/list"),
      this.fetchJSON<{ sources?: SourceDto[] }>("/sources/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source_types: null }),
      }),
    ]);

    const value: Taxonomy = { genres, sources: sources.sources ?? [] };
    this.taxonomy = { at: Date.now(), value };

    return value;
  }

  async getTags(): Promise<TagDto[]> {
    if (this.tags && Date.now() - this.tags.at < TAXONOMY_TTL_MS) {
      return this.tags.value;
    }

    this.pendingTags ??= this.loadTags().finally(() => {
      this.pendingTags = undefined;
    });

    return this.pendingTags;
  }

  private async loadTags(): Promise<TagDto[]> {
    const cached = await this.readCachedTags();

    if (cached) {
      this.tags = { at: Date.now(), value: cached };
      return cached;
    }

    // The list is ~1.8MB with timestamps and aliases; only active names are
    // kept, trimmed to what the search body and the pickers use.
    const tags = (await this.fetchJSON<TagDto[]>("/tags/list"))
      .filter((tag) => tag.id && tag.tag_name && (tag.status ?? "Active") === "Active")
      .map((tag) => ({ id: tag.id, tag_name: tag.tag_name.trim() }));
    this.tags = { at: Date.now(), value: tags };

    // Persisting is best-effort: a storage failure after a good fetch must not
    // lose the tags the caller is waiting for.
    try {
      await stateManager().store(TAGS_CACHE_KEY, JSON.stringify(tags));
      await stateManager().store(TAGS_CACHE_DATE_KEY, Date.now());
    } catch {
      // Memory cache still serves this session.
    }

    return tags;
  }

  private async readCachedTags(): Promise<TagDto[] | undefined> {
    try {
      const at = Number((await stateManager().retrieve(TAGS_CACHE_DATE_KEY)) ?? 0);
      const raw = await stateManager().retrieve(TAGS_CACHE_KEY);

      if (typeof raw !== "string" || Date.now() - at > TAXONOMY_TTL_MS) {
        return undefined;
      }

      const parsed = JSON.parse(raw) as TagDto[];

      return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  // Fire-and-forget: pulls the taxonomy into memory so the filter sheet opens
  // without waiting on it. Never surfaces an error and never blocks a caller.
  warm(): void {
    void this.getTags().catch(() => undefined);
  }

  // Lower-cased name to id, for resolving tag names typed into settings.
  async getTagIdsByName(): Promise<Record<string, string>> {
    const map: Record<string, string> = {};

    for (const tag of await this.getTags()) {
      map[tag.tag_name.toLowerCase()] = tag.id;
    }

    return map;
  }
}

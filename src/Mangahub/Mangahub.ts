/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 kittycatgit */

import {
  Chapter,
  ChapterDetails,
  ChapterProviding,
  CloudflareBypassRequestProviding,
  ContentRating,
  HomePageSectionsProviding,
  HomeSection,
  HomeSectionType,
  MangaProviding,
  PagedResults,
  PartialSourceManga,
  Request,
  RequestManager,
  Response,
  SearchRequest,
  SearchResultsProviding,
  SourceInfo,
  SourceIntents,
  SourceManga,
  SourceStateManager,
  Tag,
  TagSection,
} from "@paperback/types";

import { gqlString, MangaHubApi } from "./api";
import { decryptEncV1 } from "./crypto";
import {
  DEFAULT_SORT,
  DOMAIN,
  EXCLUDE_OPTIONS,
  FILTER_SECTIONS,
  GENRE_CACHE_TTL,
  GENRE_STATE_KEY,
  GENRES,
  HOST,
  LATEST_PAGE_SIZE,
  LATEST_SECTION_ID,
  LIST_FIELDS,
  PAGE_SIZE,
  POPULAR_UPDATES_SECTION_ID,
  SESSION_STATE_KEY,
  SORT_OPTIONS,
  SORTED_SECTIONS,
  SOURCE,
  type ApiChapterFull,
  type ApiGenre,
  type ApiManga,
  type ApiSearch,
  type Option,
  type SearchMetadata,
} from "./models";
import { coverUrl, parseChapterPages, parseChapters, parseMangaDetails, shareUrl } from "./parsers";

const ACCESS_COOKIE = "mhub_access";

const HOME_SECTIONS = [
  {
    id: POPULAR_UPDATES_SECTION_ID,
    title: "Popular Updates",
    type: HomeSectionType.featured,
  },
  { id: LATEST_SECTION_ID, title: "Latest Updates", type: HomeSectionType.singleRowNormal },
  {
    id: SORTED_SECTIONS[0]!.id,
    title: SORTED_SECTIONS[0]!.title,
    type: HomeSectionType.singleRowLarge,
  },
  {
    id: SORTED_SECTIONS[1]!.id,
    title: SORTED_SECTIONS[1]!.title,
    type: HomeSectionType.singleRowNormal,
  },
  {
    id: SORTED_SECTIONS[2]!.id,
    title: SORTED_SECTIONS[2]!.title,
    type: HomeSectionType.singleRowNormal,
  },
];

export const MangahubInfo: SourceInfo = {
  version: "4.0.0",
  name: "Mangahub",
  icon: "icon.png",
  author: "kittycatgit",
  authorWebsite: "https://github.com/kittycatgit",
  description: "Extension that pulls content from mangahub.io.",
  contentRating: ContentRating.ADULT,
  websiteBaseURL: DOMAIN,
  language: "en",
  intents:
    SourceIntents.MANGA_CHAPTERS |
    SourceIntents.HOMEPAGE_SECTIONS |
    SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
};

export class Mangahub
  implements
    ChapterProviding,
    SearchResultsProviding,
    HomePageSectionsProviding,
    CloudflareBypassRequestProviding,
    MangaProviding
{
  constructor(public cheerio: unknown) {}

  private state: SourceStateManager | undefined;

  // The access token and the Cloudflare clearance, kept by name and value only:
  // the shared cookie store drops entries by expiry date.
  private session: Record<string, string> = {};
  private sessionLoaded = false;

  private readonly api = new MangaHubApi(
    () => this.requestManager,
    () => this.session[ACCESS_COOKIE],
  );

  readonly requestManager: RequestManager = App.createRequestManager({
    requestsPerSecond: 4,
    requestTimeout: 20_000,
    interceptor: {
      interceptRequest: async (request: Request): Promise<Request> => {
        await this.loadSession();
        const isImage = /mghcdn\.com/i.test(request.url);

        request.headers = {
          ...request.headers,
          "user-agent": await this.requestManager.getDefaultUserAgent(),
          referer: `${DOMAIN}/`,
          "accept-language": "en-US,en;q=0.9",
          ...(isImage ? { accept: "image/avif,image/webp,image/*,*/*;q=0.8" } : {}),
        };

        // The page and cover hosts never see the site's cookies.
        if (!isImage && Object.keys(this.session).length > 0) {
          const carried = Object.entries(this.session).filter(
            ([name]) =>
              // The API compares its header against this cookie, and the request
              // already carries the token the header was built with.
              name !== ACCESS_COOKIE ||
              !(request.cookies ?? []).some((cookie) => cookie.name === ACCESS_COOKIE),
          );

          request.cookies = [
            ...(request.cookies ?? []),
            ...carried.map(([name, value]) =>
              App.createCookie({ name, value, domain: HOST, path: "/" }),
            ),
          ];
        }

        return request;
      },
      interceptResponse: async (response: Response): Promise<Response> => {
        await this.rememberSession(response);

        const headers = response.headers ?? {};
        const mitigated = String(headers["cf-mitigated"] ?? headers["Cf-Mitigated"] ?? "");
        const challenged =
          mitigated.toLowerCase() === "challenge" ||
          ((response.status === 403 || response.status === 503) &&
            /just a moment|challenge-platform|attention required|cf-chl/i.test(
              response.data ?? "",
            ));

        if (challenged) {
          throw new Error(
            `CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${DOMAIN}> and press the cloud icon.`,
          );
        }

        return response;
      },
    },
  });

  async getCloudflareBypassRequestAsync(): Promise<Request> {
    return App.createRequest({
      url: DOMAIN,
      method: "GET",
      headers: {
        referer: `${DOMAIN}/`,
        "user-agent": await this.requestManager.getDefaultUserAgent(),
      },
    });
  }

  getMangaShareUrl(mangaId: string): string {
    return shareUrl(mangaId);
  }

  private stateManager(): SourceStateManager {
    this.state ??= App.createSourceStateManager();
    return this.state;
  }

  private async loadSession(): Promise<void> {
    if (this.sessionLoaded) {
      return;
    }

    this.sessionLoaded = true;
    const stored = (await this.stateManager().retrieve(SESSION_STATE_KEY)) as unknown;

    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      this.session = { ...this.session, ...(stored as Record<string, string>) };
    }
  }

  private async rememberSession(response: Response): Promise<void> {
    const headers = response.headers ?? {};
    const key = Object.keys(headers).find((name) => name.toLowerCase() === "set-cookie");
    const raw: unknown = key ? headers[key] : undefined;
    const lines = Array.isArray(raw)
      ? raw.map(String)
      : typeof raw === "string"
        ? raw.split(/,(?=\s*[^;,=\s]+=)/)
        : [];

    let changed = false;

    for (const line of lines) {
      const pair = /^\s*([^=;\s]+)=([^;]*)/.exec(line);
      const name = pair?.[1];
      const value = (pair?.[2] ?? "").trim();

      if (!name) {
        continue;
      }

      if (value) {
        if (this.session[name] !== value) {
          this.session[name] = value;
          changed = true;
        }
      } else if (name in this.session) {
        // An empty value is how the server clears a cookie.
        delete this.session[name];
        changed = true;
      }
    }

    if (changed) {
      await this.stateManager().store(SESSION_STATE_KEY, { ...this.session });
    }
  }

  // The site publishes its genres; the bundled GENRES list is only a fallback so
  // the filter is never empty.
  private async genreOptions(): Promise<Option[]> {
    const cached = (await this.stateManager().retrieve(GENRE_STATE_KEY)) as
      | { at?: number; genres?: Option[] }
      | undefined;

    if (
      cached?.genres &&
      cached.genres.length > 0 &&
      typeof cached.at === "number" &&
      Date.now() - cached.at < GENRE_CACHE_TTL
    ) {
      return cached.genres;
    }

    try {
      const data = await this.api.query<{ genres?: ApiGenre[] }>(`{genres{id,slug,title}}`);

      const genres = (data.genres ?? [])
        .filter((genre) => genre?.slug && genre?.title)
        .map((genre) => ({ id: genre.slug, label: genre.title }))
        .sort((a, b) => a.label.localeCompare(b.label));

      if (genres.length > 0) {
        await this.stateManager().store(GENRE_STATE_KEY, { at: Date.now(), genres });
        return genres;
      }
    } catch {
      // fall back to the bundled list below
    }

    return cached?.genres && cached.genres.length > 0 ? cached.genres : GENRES;
  }

  async getSearchTags(): Promise<TagSection[]> {
    const genres = await this.genreOptions();

    return [
      App.createTagSection({
        id: "genres",
        // The API ORs genres together, so each one added returns more rows.
        label: "Genres (any of)",
        tags: genres.map((genre) => App.createTag({ id: genre.id, label: genre.label })),
      }),
      ...FILTER_SECTIONS.map((section) =>
        App.createTagSection({
          id: section.id,
          label: section.label,
          tags: section.options.map((option) =>
            App.createTag({ id: `${section.id}:${option.id}`, label: option.label }),
          ),
        }),
      ),
    ];
  }

  async supportsTagExclusion(): Promise<boolean> {
    return false;
  }

  private filtersFrom(tags: Tag[] | undefined): Omit<SearchMetadata, "offset"> {
    const genres: string[] = [];
    const excluded: string[] = [];
    let sort = DEFAULT_SORT;

    for (const tag of tags ?? []) {
      const id = tag.id ?? "";
      const separator = id.indexOf(":");
      const prefix = separator > 0 ? id.slice(0, separator) : "";
      const value = separator > 0 ? id.slice(separator + 1) : "";

      if (prefix === "sort") {
        if (SORT_OPTIONS.some((option) => option.id === value)) {
          sort = value;
        }
      } else if (prefix === "exclude") {
        if (EXCLUDE_OPTIONS.some((option) => option.id === value)) {
          excluded.push(value);
        }
      } else if (id) {
        genres.push(id);
      }
    }

    return {
      sort,
      ...(genres.length > 0 ? { genres } : {}),
      ...(excluded.includes("hideNSFW") ? { hideNSFW: true } : {}),
      ...(excluded.includes("hideYaoi") ? { hideYaoi: true } : {}),
      ...(excluded.includes("hideLicensed") ? { hideLicensed: true } : {}),
    };
  }

  private searchArgs(
    title: string,
    filters: SearchMetadata,
    offset: number,
    limit: number,
  ): string {
    // A comma-joined list of slugs, or "all" for no filter. An unknown slug makes
    // the resolver throw, so only slugs we offered are sent.
    const genre = filters.genres && filters.genres.length > 0 ? filters.genres.join(",") : "all";

    return [
      `x:${SOURCE}`,
      `q:${gqlString(title)}`,
      `genre:${gqlString(genre)}`,
      `mod:${filters.sort ?? DEFAULT_SORT}`,
      ...(filters.hideNSFW ? ["hideNSFW:true"] : []),
      ...(filters.hideYaoi ? ["hideYaoi:true"] : []),
      ...(filters.hideLicensed ? ["hideLicensed:true"] : []),
      `limit:${limit}`,
      `offset:${offset}`,
      "count:true",
    ].join(",");
  }

  async getSearchResults(query: SearchRequest, metadata: unknown): Promise<PagedResults> {
    const paging = metadata as SearchMetadata | undefined;
    const filters = paging ?? this.filtersFrom(query.includedTags);
    const offset = paging?.offset ?? 0;

    const data = await this.api.query<{ search?: ApiSearch }>(
      `{search(${this.searchArgs((query.title ?? "").trim(), filters, offset, PAGE_SIZE)}){rows{${LIST_FIELDS}},count}}`,
    );

    const rows = data.search?.rows ?? [];
    const total = data.search?.count ?? 0;
    const nextOffset = offset + rows.length;

    return App.createPagedResults({
      results: rows.map((row) => this.listItem(row)),
      metadata:
        rows.length > 0 && nextOffset < total ? { ...filters, offset: nextOffset } : undefined,
    });
  }

  private listItem(row: ApiManga): PartialSourceManga {
    return App.createPartialSourceManga({
      mangaId: row.slug,
      title: row.title?.trim() || row.slug,
      image: coverUrl(row.image),
      ...(typeof row.latestChapter === "number"
        ? { subtitle: `Chapter ${row.latestChapter}` }
        : {}),
    });
  }

  async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
    for (const entry of HOME_SECTIONS) {
      sectionCallback(
        App.createHomeSection({
          ...entry,
          containsMoreItems: entry.id !== POPULAR_UPDATES_SECTION_ID,
        }),
      );
    }

    // Each rail fills on its own: one failing call must not take the others down with it.
    await Promise.all(
      HOME_SECTIONS.map(async (entry) => {
        try {
          const items = await this.sectionItems(entry.id, 0);
          sectionCallback(
            App.createHomeSection({
              ...entry,
              containsMoreItems: entry.id !== POPULAR_UPDATES_SECTION_ID,
              items,
            }),
          );
        } catch (e) {
          console.log(`MangaHub: rail ${entry.id} failed: ${String(e)}`);
        }
      }),
    );
  }

  async getViewMoreItems(homepageSectionId: string, metadata: unknown): Promise<PagedResults> {
    const offset = (metadata as { offset?: number } | undefined)?.offset ?? 0;
    const items = await this.sectionItems(homepageSectionId, offset);

    return App.createPagedResults({
      results: items,
      metadata: items.length > 0 ? { offset: offset + items.length } : undefined,
    });
  }

  private async sectionItems(sectionId: string, offset: number): Promise<PartialSourceManga[]> {
    if (sectionId === POPULAR_UPDATES_SECTION_ID) {
      // latestPopular takes no paging arguments; it answers with a fixed set.
      if (offset > 0) {
        return [];
      }

      const data = await this.api.query<{ latestPopular?: ApiManga[] }>(
        `{latestPopular(x:${SOURCE}){id,title,slug,image,latestChapter,isSafe,isLicensed}}`,
      );

      return (data.latestPopular ?? []).map((row) => this.listItem(row));
    }

    if (sectionId === LATEST_SECTION_ID) {
      return await this.latestUpdates(offset);
    }

    const sorted = SORTED_SECTIONS.find((entry) => entry.id === sectionId);

    if (!sorted) {
      return [];
    }

    const data = await this.api.query<{ search?: ApiSearch }>(
      `{search(x:${SOURCE},q:"",genre:"all",mod:${sorted.mod},limit:${PAGE_SIZE},offset:${offset},count:true){rows{${LIST_FIELDS}},count}}`,
    );

    return (data.search?.rows ?? []).map((row) => this.listItem(row));
  }

  private async latestUpdates(offset: number): Promise<PartialSourceManga[]> {
    const data = await this.api.query<{ latest?: ApiManga[] }>(
      `{latest(x:${SOURCE},limit:${LATEST_PAGE_SIZE},offset:${offset}){id,title,slug,image,latestChapter,isSafe,isLicensed,updatedDate,chapters{id,number,title,date}}}`,
    );

    const items: PartialSourceManga[] = [];

    for (const row of data.latest ?? []) {
      const newest = [...(row.chapters ?? [])].sort((a, b) => b.number - a.number)[0];
      const number = newest?.number ?? row.latestChapter;

      items.push(
        App.createPartialSourceManga({
          mangaId: row.slug,
          title: row.title?.trim() || row.slug,
          image: coverUrl(row.image),
          ...(typeof number === "number" ? { subtitle: `Chapter ${number}` } : {}),
        }),
      );
    }

    return items;
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const data = await this.api.query<{ manga?: ApiManga }>(
      `{manga(x:${SOURCE},slug:${gqlString(mangaId)}){id,rank,title,alternativeTitle,slug,mainSlug,status,image,latestChapter,genres,author,artist,isWebtoon,isYaoi,isPorn,isSoftPorn,isSafe,isLicensed,description,createdDate,updatedDate,chapters{id,number,title,slug,date}}}`,
    );

    if (!data.manga) {
      throw new Error(`No title found for ${mangaId}`);
    }

    return parseMangaDetails(data.manga);
  }

  async getChapters(mangaId: string): Promise<Chapter[]> {
    const data = await this.api.query<{ manga?: ApiManga }>(
      `{manga(x:${SOURCE},slug:${gqlString(mangaId)}){id,chapters{id,number,title,slug,date}}}`,
    );

    return parseChapters(data.manga?.chapters ?? []);
  }

  async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
    const number = Number(chapterId);

    const { data, keys } = await this.api.queryChapter<{ chapter?: ApiChapterFull }>(
      `{chapter(x:${SOURCE},slug:${gqlString(mangaId)},number:${number}){id,mangaID,number,title,slug,date,pages,s}}`,
    );

    if (!data.chapter) {
      throw new Error(`Chapter ${chapterId} is no longer listed for ${mangaId}`);
    }

    // The page list arrives as AES-GCM ciphertext keyed to the request's access token.
    const payload = data.chapter.pages;
    const pages = parseChapterPages({
      ...data.chapter,
      pages: payload?.startsWith("enc:v1:") ? decryptEncV1(payload, keys) : payload,
    });

    if (pages.length === 0) {
      throw new Error(`Unable to read any pages for chapter ${chapterId}`);
    }

    return App.createChapterDetails({ id: chapterId, mangaId, pages });
  }
}

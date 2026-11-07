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

import { compact, HiperDexApi, ReaderForbiddenError } from "./api";
import {
  CHAPTER_COUNT_KEY,
  CHAPTER_COUNT_MAX,
  CHAPTER_COUNT_TTL_MS,
  DEFAULT_SORT,
  DOMAIN,
  FALLBACK_COVER,
  FILTER_SECTIONS,
  GENRE_CACHE_TTL,
  GENRE_STATE_KEY,
  GENRES,
  LATEST_PAGE_SIZE,
  LATEST_SECTION_ID,
  MAX_RATING,
  PAGE_SIZE,
  READER_HEADER,
  READER_TOKEN,
  SESSION_STATE_KEY,
  SORT_OPTIONS,
  TRENDING_PAGE_SIZE,
  TRENDING_SECTIONS,
  type ApiChapter,
  type ApiGenre,
  type ApiLatestItem,
  type ApiPage,
  type ApiSeries,
  type ApiTrendingItem,
  type Option,
  type SearchMetadata,
} from "./models";
import {
  capitalise,
  parseChapterPages,
  parseChapters,
  parseMangaDetails,
  shareUrl,
} from "./parsers";

const HOST = DOMAIN.replace(/^https?:\/\//, "");

const HOME_SECTIONS = [
  {
    id: TRENDING_SECTIONS[0]!.id,
    title: TRENDING_SECTIONS[0]!.title,
    type: HomeSectionType.featured,
  },
  { id: LATEST_SECTION_ID, title: "Recent Updates", type: HomeSectionType.singleRowNormal },
  {
    id: TRENDING_SECTIONS[1]!.id,
    title: TRENDING_SECTIONS[1]!.title,
    type: HomeSectionType.singleRowLarge,
  },
  {
    id: TRENDING_SECTIONS[2]!.id,
    title: TRENDING_SECTIONS[2]!.title,
    type: HomeSectionType.singleRowNormal,
  },
];

export const HiperDexInfo: SourceInfo = {
  version: "1.0.0",
  name: "HiperDex",
  icon: "icon.png",
  author: "kittycatgit",
  authorWebsite: "https://github.com/kittycatgit",
  description: "Extension that pulls content from hiperdex.tv.",
  contentRating: ContentRating.ADULT,
  websiteBaseURL: DOMAIN,
  language: "en",
  intents:
    SourceIntents.MANGA_CHAPTERS |
    SourceIntents.HOMEPAGE_SECTIONS |
    SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
};

export class HiperDex
  implements
    ChapterProviding,
    SearchResultsProviding,
    HomePageSectionsProviding,
    CloudflareBypassRequestProviding,
    MangaProviding
{
  constructor(public cheerio: unknown) {}

  private state: SourceStateManager | undefined;

  // Every API procedure answers 401 without the anonymous cookie the root
  // document issues. Kept by name and value only, since the shared cookie store
  // drops entries by expiry date.
  private session: Record<string, string> = {};
  private sessionLoaded = false;

  private readonly api = new HiperDexApi(DOMAIN, () => this.requestManager);

  readonly requestManager: RequestManager = App.createRequestManager({
    requestsPerSecond: 4,
    requestTimeout: 20_000,
    interceptor: {
      interceptRequest: async (request: Request): Promise<Request> => {
        await this.loadSession();
        const isImage = /r2d2storage\.com/i.test(request.url);

        request.headers = {
          ...request.headers,
          "user-agent": await this.requestManager.getDefaultUserAgent(),
          referer: `${DOMAIN}/`,
          "accept-language": "en-US,en;q=0.9",
          accept: isImage
            ? "image/avif,image/webp,image/*,*/*;q=0.8"
            : "application/json,text/plain,*/*",
        };

        // Images come from a separate host that never sees these cookies.
        if (!isImage && Object.keys(this.session).length > 0) {
          request.cookies = [
            ...(request.cookies ?? []),
            ...Object.entries(this.session).map(([name, value]) =>
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
      const rows = await this.api.query<ApiGenre[]>("search.genres", null);

      const genres = (Array.isArray(rows) ? rows : [])
        .filter((row) => row?.slug && row?.name)
        .map((row) => ({ id: row.slug, label: row.name }))
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

  // The search filter matches display names, not slugs: "age-gap" finds nothing
  // where "Age Gap" works. Tag ids stay slugs because an id cannot hold spaces.
  private async genreNames(slugs: string[]): Promise<string[]> {
    const options = await this.genreOptions();
    const bySlug = new Map(options.map((option) => [option.id, option.label]));

    return slugs.map((slug) => bySlug.get(slug) ?? slug.replace(/-/g, " "));
  }

  async getSearchTags(): Promise<TagSection[]> {
    const genres = await this.genreOptions();

    return [
      App.createTagSection({
        id: "genres",
        label: "Genres",
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
    const picked: Record<string, string> = {};

    for (const tag of tags ?? []) {
      const id = tag.id ?? "";
      const separator = id.indexOf(":");
      const prefix = separator > 0 ? id.slice(0, separator) : "";

      if (prefix && FILTER_SECTIONS.some((section) => section.id === prefix)) {
        picked[prefix] ??= id.slice(separator + 1);
      } else if (id) {
        genres.push(id);
      }
    }

    const sort = picked["sort"];

    return {
      sort: sort && SORT_OPTIONS.some((option) => option.id === sort) ? sort : DEFAULT_SORT,
      ...(genres.length > 0 ? { genres } : {}),
      ...(picked["type"] ? { type: picked["type"] } : {}),
      ...(picked["status"] ? { status: picked["status"] } : {}),
      ...(picked["rating"] ? { contentRating: picked["rating"] } : {}),
    };
  }

  async getSearchResults(query: SearchRequest, metadata: unknown): Promise<PagedResults> {
    const paging = metadata as SearchMetadata | undefined;
    const filters = paging ?? this.filtersFrom(query.includedTags);
    const offset = paging?.offset ?? 0;

    const response = await this.api.query<{ hits?: ApiSeries[]; totalHits?: number }>(
      "search.query",
      {
        q: (query.title ?? "").trim(),
        sort: filters.sort,
        // An unset filter has to be absent: the API rejects an explicit null.
        filters: compact({
          genres: filters.genres ? await this.genreNames(filters.genres) : undefined,
          type: filters.type,
          status: filters.status,
          contentRating: filters.contentRating,
        }),
        limit: PAGE_SIZE,
        offset,
        maxRating: MAX_RATING,
      },
    );

    const hits = response?.hits ?? [];
    const total = response?.totalHits ?? 0;
    const nextOffset = offset + hits.length;
    const counts = await this.chapterCounts(hits);

    return App.createPagedResults({
      results: hits.map((hit) => this.searchItem(hit, counts.get(hit.id))),
      metadata:
        hits.length > 0 && nextOffset < total ? { ...filters, offset: nextOffset } : undefined,
    });
  }

  // Search hits carry no chapter count, so it takes one query per series;
  // batched into a single round trip and cached, since the same titles recur.
  private async chapterCounts(hits: ApiSeries[]): Promise<Map<number, number>> {
    const store =
      ((await this.stateManager().retrieve(CHAPTER_COUNT_KEY)) as
        | Record<string, { n: number; at: number }>
        | undefined) ?? {};
    const counts = new Map<number, number>();
    const fresh = Date.now() - CHAPTER_COUNT_TTL_MS;
    const missing: ApiSeries[] = [];

    for (const hit of hits) {
      const held = store[String(hit.id)];

      if (held && held.at >= fresh) {
        counts.set(hit.id, held.n);
      } else {
        missing.push(hit);
      }
    }

    if (missing.length === 0) {
      return counts;
    }

    const answers = await this.api.queryEach<ApiChapter[]>(
      "series.chapters",
      missing.map((hit) => ({ seriesId: hit.id })),
    );

    let learned = false;

    answers.forEach((rows, index) => {
      const hit = missing[index];

      if (!hit || !Array.isArray(rows)) {
        return;
      }

      counts.set(hit.id, rows.length);
      store[String(hit.id)] = { n: rows.length, at: Date.now() };
      learned = true;
    });

    if (learned) {
      const trimmed = Object.entries(store)
        .sort(([, a], [, b]) => b.at - a.at)
        .slice(0, CHAPTER_COUNT_MAX);
      await this.stateManager().store(CHAPTER_COUNT_KEY, Object.fromEntries(trimmed));
    }

    return counts;
  }

  private searchItem(hit: ApiSeries, chapters?: number): PartialSourceManga {
    const bits: string[] = [];
    if (hit.type) {
      bits.push(capitalise(hit.type));
    }
    if (chapters !== undefined && chapters > 0) {
      bits.push(`${chapters} chapter${chapters === 1 ? "" : "s"}`);
    }
    if (typeof hit.score === "number") {
      bits.push(`${hit.score.toFixed(1)}/5`);
    }

    return App.createPartialSourceManga({
      mangaId: hit.slug,
      title: hit.title?.trim() || hit.slug,
      image: hit.coverUrl || FALLBACK_COVER,
      ...(bits.length > 0 ? { subtitle: bits.join(" • ") } : {}),
    });
  }

  async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
    for (const entry of HOME_SECTIONS) {
      sectionCallback(App.createHomeSection({ ...entry, containsMoreItems: true }));
    }

    await Promise.all(
      HOME_SECTIONS.map(async (entry) => {
        const page = await this.sectionPage(entry.id, 1);

        sectionCallback(
          App.createHomeSection({ ...entry, containsMoreItems: true, items: page.results }),
        );
      }),
    );
  }

  async getViewMoreItems(homepageSectionId: string, metadata: unknown): Promise<PagedResults> {
    const page = (metadata as { page?: number } | undefined)?.page ?? 1;
    return await this.sectionPage(homepageSectionId, page);
  }

  private async sectionPage(sectionId: string, page: number): Promise<PagedResults> {
    const results =
      sectionId === LATEST_SECTION_ID
        ? await this.latestUpdates(page)
        : await this.trending(sectionId, page);

    return App.createPagedResults({
      results,
      metadata: results.length > 0 ? { page: page + 1 } : undefined,
    });
  }

  private async trending(sectionId: string, page: number): Promise<PartialSourceManga[]> {
    const section = TRENDING_SECTIONS.find((entry) => entry.id === sectionId);

    if (!section) {
      return [];
    }

    const rows = await this.api.query<ApiTrendingItem[]>("recommendations.trending", {
      limit: TRENDING_PAGE_SIZE,
      page,
      maxRating: MAX_RATING,
      period: section.period,
    });

    return (Array.isArray(rows) ? rows : []).map((row) =>
      App.createPartialSourceManga({
        mangaId: row.slug,
        title: row.title?.trim() || row.slug,
        image: row.coverUrl || FALLBACK_COVER,
        ...(row.latestChapter ? { subtitle: `Chapter ${row.latestChapter.number}` } : {}),
      }),
    );
  }

  private async latestUpdates(page: number): Promise<PartialSourceManga[]> {
    const rows = await this.api.query<ApiLatestItem[]>("recommendations.latestChapters", {
      limit: LATEST_PAGE_SIZE,
      page,
      maxRating: MAX_RATING,
      seriesType: "all",
    });

    const items: PartialSourceManga[] = [];

    for (const row of Array.isArray(rows) ? rows : []) {
      const newest = (row.chapters ?? [])[0];

      if (!newest) {
        continue;
      }

      items.push(
        App.createPartialSourceManga({
          mangaId: row.seriesSlug,
          title: row.seriesTitle?.trim() || row.seriesSlug,
          image: row.seriesCoverUrl || FALLBACK_COVER,
          subtitle: `Chapter ${newest.number}`,
        }),
      );
    }

    return items;
  }

  private async series(mangaId: string): Promise<ApiSeries> {
    const series = await this.api.query<ApiSeries>("series.bySlugWithGenres", { slug: mangaId });

    if (!series) {
      throw new Error(`No title found for ${mangaId}`);
    }

    return series;
  }

  private async chapterRows(seriesId: number): Promise<ApiChapter[]> {
    const rows = await this.api.query<ApiChapter[]>("series.chapters", { seriesId });
    return Array.isArray(rows) ? rows : [];
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const series = await this.series(mangaId);

    let chapterCount: number | undefined;
    try {
      chapterCount = (await this.chapterRows(series.id)).length;
    } catch {
      chapterCount = undefined;
    }

    return parseMangaDetails(series, chapterCount);
  }

  async getChapters(mangaId: string): Promise<Chapter[]> {
    const series = await this.series(mangaId);
    return parseChapters(await this.chapterRows(series.id));
  }

  async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
    const chapterNumber = Number(chapterId);

    // The reader needs the chapter id as well as its number, and only the
    // chapter list carries the id.
    const series = await this.series(mangaId);
    const row = (await this.chapterRows(series.id)).find((entry) => entry.number === chapterNumber);

    if (!row) {
      throw new Error(`Chapter ${chapterId} is no longer listed for ${mangaId}`);
    }

    let pages: ApiPage[];
    try {
      pages = await this.api.query<ApiPage[]>(
        "reader.chapterPages",
        { seriesSlug: mangaId, chapterNumber, chapterId: row.id },
        { [READER_HEADER]: READER_TOKEN },
      );
    } catch (error: unknown) {
      if (error instanceof ReaderForbiddenError) {
        throw new Error(
          "The site refused the page request: its reader token has changed and this version cannot read the new one.",
        );
      }

      throw error;
    }

    const urls = parseChapterPages(Array.isArray(pages) ? pages : []);

    if (urls.length === 0) {
      throw new Error(`Unable to read any pages for chapter ${chapterId}`);
    }

    return App.createChapterDetails({ id: chapterId, mangaId, pages: urls });
  }
}

/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 kittycatgit */

import { CheerioAPI } from "cheerio";
import {
  Chapter,
  ChapterDetails,
  ChapterProviding,
  CloudflareBypassRequestProviding,
  ContentRating,
  DUISection,
  HomePageSectionsProviding,
  HomeSection,
  HomeSectionType,
  PagedResults,
  PartialSourceManga,
  Request,
  RequestManager,
  SearchField,
  SearchRequest,
  SearchResultsProviding,
  SourceInfo,
  SourceIntents,
  SourceManga,
  Tag,
  TagSection,
} from "@paperback/types";

import { isCloudflareChallenge, KaganeApi, originOf } from "./api";
import {
  DEFAULT_DOMAIN,
  FORMATS,
  HOME_SECTIONS,
  MIRRORS_URL,
  PAGE_SIZE,
  SORT_FIELDS,
  UPLOAD_STATUSES,
  type BookIndexDto,
  type DetailsDto,
  type SearchBook,
  type SearchDto,
  type SourceDto,
  type TrendingDto,
} from "./models";
import { buildSettings } from "./settings";
import {
  getChallengeHost,
  getContentLanguages,
  getContentRatings,
  getCustomHiddenTags,
  getExcludedGenres,
  getHiddenTagIds,
  getShowDisturbing,
  getShowPornographic,
  getShowSource,
  getSourceDisplayMode,
  getSourceTypes,
  getTagMatchAll,
  setChallengeHost,
} from "./state";
import { POPULAR_TAG_NAMES } from "./tags";

// null and "" are "not set", which Number() would silently read as 0.
function numberOrNaN(value: unknown): number {
  return value === null || value === undefined || value === "" ? NaN : Number(value);
}

export const KaganeInfo: SourceInfo = {
  version: "6.0.0",
  name: "Kagane",
  icon: "icon.png",
  author: "kittycatgit",
  authorWebsite: "https://github.com/kittycatgit",
  description: "Extension that pulls content from Kagane, on whichever domain kagane.org lists.",
  contentRating: ContentRating.MATURE,
  websiteBaseURL: MIRRORS_URL,
  language: "en",
  intents:
    SourceIntents.MANGA_CHAPTERS |
    SourceIntents.HOMEPAGE_SECTIONS |
    SourceIntents.SETTINGS_UI |
    SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
};

export class Kagane
  implements
    SearchResultsProviding,
    ChapterProviding,
    HomePageSectionsProviding,
    CloudflareBypassRequestProviding
{
  constructor(public cheerio: CheerioAPI) {}

  readonly requestManager: RequestManager = App.createRequestManager({
    requestTimeout: 20_000,
    interceptor: {
      // The page CDN only serves with the site's Origin; the mirrors page and
      // the API accept their own. Resolving here would recurse, so the domain
      // already in memory is used and the request's own host otherwise.
      interceptRequest: async (request: Request): Promise<Request> => {
        const requestOrigin = originOf(request.url);
        const origin =
          requestOrigin === MIRRORS_URL.replace(/\/$/, "")
            ? requestOrigin
            : this.api.knownDomain || requestOrigin;

        request.headers = {
          ...request.headers,
          origin,
          referer: `${origin}/`,
          "user-agent": await this.requestManager.getDefaultUserAgent(),
        };

        return request;
      },
      interceptResponse: async (response) => {
        if (isCloudflareChallenge(response)) {
          await setChallengeHost(originOf(response.request.url));
        }

        return response;
      },
    },
  });

  private readonly api = new KaganeApi(this.requestManager);

  // Whichever host challenged last is the one the bypass must clear.
  async getCloudflareBypassRequestAsync(): Promise<Request> {
    const challenged = await getChallengeHost();
    const url = challenged || this.api.knownDomain || DEFAULT_DOMAIN;

    return App.createRequest({
      url,
      method: "GET",
      headers: { "user-agent": await this.requestManager.getDefaultUserAgent() },
    });
  }

  async getSourceMenu(): Promise<DUISection> {
    return buildSettings(this.api);
  }

  // Share links are built before any request runs, so this uses what is known
  // and the mirrors page when nothing is.
  getMangaShareUrl(mangaId: string): string {
    const domain = this.api.knownDomain;

    return domain ? `${domain}/series/${mangaId}` : MIRRORS_URL;
  }

  // Some series carry no cover at all. The fallback has to be a URL the app can
  // try and fail on: an empty string blanks the whole row.
  private cover(domain: string, imageId?: string | null): string {
    return imageId ? `${domain}/api/v2/image/${imageId}/compressed` : `${domain}/image/none.webp`;
  }

  // Tag ids carry the group they came from so the search body can put each one
  // in the right field; ids never contain spaces, which Paperback rejects.
  async getSearchTags(): Promise<TagSection[]> {
    const [{ genres, sources }, tags, mode] = await Promise.all([
      this.api.getTaxonomy(),
      this.api.getTags(),
      getSourceDisplayMode(),
    ]);

    const wanted = new Set(POPULAR_TAG_NAMES.map((name) => name.toLowerCase()));
    const popular = tags
      .filter((tag) => wanted.has(tag.tag_name.toLowerCase()))
      .sort((left, right) => left.tag_name.localeCompare(right.tag_name));

    const visibleSources = sources
      .filter((source) => this.matchesMode(source, mode))
      .sort((left, right) => left.title.localeCompare(right.title));

    const sections: TagSection[] = [
      App.createTagSection({
        id: "sort",
        label: "Sort",
        tags: SORT_FIELDS.map((sort) =>
          App.createTag({ id: `sort:${sort.id}`, label: sort.title }),
        ),
      }),
      App.createTagSection({
        id: "genres",
        label: "Genres",
        tags: [...genres]
          .sort((left, right) => left.genre_name.localeCompare(right.genre_name))
          .map((genre) => App.createTag({ id: `genre:${genre.id}`, label: genre.genre_name })),
      }),
      App.createTagSection({
        id: "tags",
        label: "Tags",
        tags: popular.map((tag) => App.createTag({ id: `tag:${tag.id}`, label: tag.tag_name })),
      }),
      App.createTagSection({
        id: "formats",
        label: "Format",
        tags: FORMATS.map((format) => App.createTag({ id: `format:${format}`, label: format })),
      }),
      App.createTagSection({
        id: "statuses",
        label: "Status",
        tags: UPLOAD_STATUSES.map((status) =>
          App.createTag({ id: `status:${status.id}`, label: status.title }),
        ),
      }),
      App.createTagSection({
        id: "sources",
        label: "Sources",
        tags: visibleSources.map((source) =>
          App.createTag({
            id: `source:${source.source_id}`,
            label: source.source_type === "Official" ? `${source.title} ⭐` : source.title,
          }),
        ),
      }),
    ];

    return sections.filter((section) => (section.tags?.length ?? 0) > 0);
  }

  private matchesMode(source: SourceDto, mode: string): boolean {
    if (mode === "official") {
      return source.source_type === "Official";
    }

    if (mode === "scanlations") {
      return source.source_type !== "Official";
    }

    return true;
  }

  // Only a few hundred of the thousands of tags fit in a picker, so this
  // reaches the rest by name. A leading "-" excludes: "romance, -gore".
  async getSearchFields(): Promise<SearchField[]> {
    return [
      App.createSearchField({
        id: "tags_text",
        name: "Tags",
        placeholder: "romance, -gore",
      }),
    ];
  }

  async supportsTagExclusion(): Promise<boolean> {
    return true;
  }

  private split(tags: Tag[] | undefined, prefix: string): string[] {
    return (tags ?? [])
      .map((tag) => tag.id ?? "")
      .filter((id) => id.startsWith(`${prefix}:`))
      .map((id) => id.slice(prefix.length + 1));
  }

  // The explicit and disturbing flags are what the site sends for a signed-out
  // reader: absent means "show", false means "hide".
  private async searchBody(query?: SearchRequest): Promise<Record<string, unknown>> {
    const [
      ratings,
      pornographic,
      disturbing,
      languages,
      sourceTypes,
      excludedGenres,
      hiddenTagIds,
      customHidden,
      matchAll,
    ] = await Promise.all([
      getContentRatings(),
      getShowPornographic(),
      getShowDisturbing(),
      getContentLanguages(),
      getSourceTypes(),
      getExcludedGenres(),
      getHiddenTagIds(),
      getCustomHiddenTags(),
      getTagMatchAll(),
    ]);

    const adult = ratings.includes("EighteenPlus");
    const body: Record<string, unknown> = {
      age_rating: ratings,
      source_type: sourceTypes,
      content_lang: languages,
      ...(adult && pornographic ? {} : { is_pornographic: false }),
      ...(adult && disturbing ? {} : { is_disturbing: false }),
    };

    const title = query?.title?.trim();
    if (title) {
      body.title = title;
    }

    const formats = this.split(query?.includedTags, "format");
    if (formats.length > 0) {
      body.format = formats;
    }

    const statuses = this.split(query?.includedTags, "status");
    if (statuses.length > 0) {
      body.upload_status = statuses;
    }

    const sourceIds = this.split(query?.includedTags, "source");
    if (sourceIds.length > 0) {
      body.source_id = sourceIds;
    }

    const includedGenres = this.split(query?.includedTags, "genre");
    const excluded = [...this.split(query?.excludedTags, "genre"), ...excludedGenres];
    if (includedGenres.length > 0 || excluded.length > 0) {
      body.genres = this.compound(includedGenres, excluded, matchAll);
    }

    const includedTags = this.split(query?.includedTags, "tag");
    const excludedTags = [...this.split(query?.excludedTags, "tag"), ...hiddenTagIds];
    const typed = this.parseTypedTags(String(query?.parameters?.["tags_text"] ?? ""));

    // Names are resolved here so the full taxonomy is only fetched when
    // somebody actually typed one. Names that match nothing drop out quietly.
    const names = [...customHidden, ...typed.included, ...typed.excluded];
    if (names.length > 0) {
      const byName = await this.api.getTagIdsByName();
      const resolve = (list: string[]) =>
        list.map((name) => byName[name.toLowerCase()] ?? "").filter(Boolean);

      includedTags.push(...resolve(typed.included));
      excludedTags.push(...resolve(customHidden), ...resolve(typed.excluded));
    }

    if (includedTags.length > 0 || excludedTags.length > 0) {
      body.tags = this.compound(includedTags, excludedTags, matchAll);
    }

    return body;
  }

  private parseTypedTags(input: string): { included: string[]; excluded: string[] } {
    const included: string[] = [];
    const excluded: string[] = [];

    for (const entry of input.split(",")) {
      const trimmed = entry.trim();
      const exclude = trimmed.startsWith("-");
      const name = (exclude ? trimmed.slice(1) : trimmed).trim();

      if (name) {
        (exclude ? excluded : included).push(name);
      }
    }

    return { included, excluded };
  }

  private compound(included: string[], excluded: string[], matchAll: boolean) {
    return {
      values: included,
      match_all: matchAll && included.length > 0,
      ...(excluded.length > 0 ? { exclude: [...new Set(excluded)] } : {}),
    };
  }

  private async sourceTitles(): Promise<Map<string, string>> {
    // The source list is only there to print a name beside the title, so it is
    // not fetched at all unless that setting is on.
    if (!(await getShowSource())) {
      return new Map();
    }

    const { sources } = await this.api.getTaxonomy();

    return new Map(sources.map((source) => [source.source_id, source.title]));
  }

  private card(domain: string, book: SearchBook, titles: Map<string, string>): PartialSourceManga {
    const source = book.source_id ? titles.get(book.source_id) : undefined;
    const latest = book.latest_chapters?.[0]?.chapter_no;
    const subtitle = [
      latest
        ? `Ch. ${latest}`
        : typeof book.current_books === "number"
          ? `${book.current_books} Chapters`
          : "",
      book.start_year ? String(book.start_year) : "",
    ]
      .filter(Boolean)
      .join(" • ");

    return App.createPartialSourceManga({
      mangaId: book.series_id,
      title: source ? `${book.title.trim()} [${source}]` : book.title.trim(),
      image: this.cover(domain, book.cover_image_id),
      ...(subtitle ? { subtitle } : {}),
    });
  }

  private async series(
    body: Record<string, unknown>,
    page: number,
    sort?: string,
  ): Promise<{ results: PartialSourceManga[]; hasNext: boolean }> {
    const parts = [`page=${page}`, `size=${PAGE_SIZE}`];

    if (sort) {
      parts.push(`sort=${sort}`);
    }

    const [domain, data, titles] = await Promise.all([
      this.api.domain(),
      this.api.fetchJSON<SearchDto>(`/search/series?${parts.join("&")}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      this.sourceTitles(),
    ]);

    const results = (data.content ?? []).map((book) => this.card(domain, book, titles));

    return { results, hasNext: data.last === false && results.length > 0 };
  }

  private async trending(): Promise<PartialSourceManga[]> {
    const [domain, ratings, languages] = await Promise.all([
      this.api.domain(),
      getContentRatings(),
      getContentLanguages(),
    ]);
    const query = [
      "limit=36",
      `age_rating=${ratings.join(",")}`,
      ...(languages.length > 0 ? [`lang=${languages.join(",")}`] : []),
    ];
    const data = await this.api.fetchJSON<TrendingDto>(`/series/trending?${query.join("&")}`);

    return (data.items ?? []).flatMap((item) => {
      const series = item.series;

      if (!series?.series_id) {
        return [];
      }

      return [
        App.createPartialSourceManga({
          mangaId: series.series_id,
          title: series.title.trim(),
          image: this.cover(domain, series.cover_image_id),
          ...(typeof series.current_books === "number"
            ? { subtitle: `${series.current_books} Chapters` }
            : {}),
        }),
      ];
    });
  }

  private section(index: number, items?: PartialSourceManga[]): HomeSection {
    const entry = HOME_SECTIONS[index]!;

    return App.createHomeSection({
      id: entry.id,
      title: entry.title,
      type: index === 0 ? HomeSectionType.singleRowLarge : HomeSectionType.singleRowNormal,
      containsMoreItems: entry.sort !== "",
      ...(items ? { items } : {}),
    });
  }

  // Every row is fetched together rather than one after another; a row that
  // fails stays empty so the others still paint.
  async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
    for (const index of HOME_SECTIONS.keys()) {
      sectionCallback(this.section(index));
    }

    const body = await this.searchBody();
    const rows = await Promise.all(
      HOME_SECTIONS.map((entry) =>
        (entry.sort === ""
          ? this.trending()
          : this.series(body, 0, entry.sort).then((row) => row.results)
        ).catch(() => [] as PartialSourceManga[]),
      ),
    );

    for (const index of HOME_SECTIONS.keys()) {
      sectionCallback(this.section(index, rows[index] ?? []));
    }

    // Rows are already painted; pull the tag list in behind them so the filter
    // sheet opens without a wait.
    this.api.warm();
  }

  async getViewMoreItems(homepageSectionId: string, metadata: unknown): Promise<PagedResults> {
    const entry = HOME_SECTIONS.find((row) => row.id === homepageSectionId);

    if (!entry || entry.sort === "") {
      return App.createPagedResults({ results: [] });
    }

    const page = (metadata as { page?: number } | undefined)?.page ?? 0;
    const { results, hasNext } = await this.series(await this.searchBody(), page, entry.sort);

    return App.createPagedResults({
      results,
      metadata: hasNext ? { page: page + 1 } : undefined,
    });
  }

  async getSearchResults(query: SearchRequest, metadata: unknown): Promise<PagedResults> {
    const page = (metadata as { page?: number } | undefined)?.page ?? 0;
    const sort = this.split(query.includedTags, "sort")[0];
    const { results, hasNext } = await this.series(
      await this.searchBody(query),
      page,
      sort ? `${sort},desc` : undefined,
    );

    return App.createPagedResults({
      results,
      metadata: hasNext ? { page: page + 1 } : undefined,
    });
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const [domain, data, taxonomy] = await Promise.all([
      this.api.domain(),
      this.api.fetchJSON<DetailsDto>(`/series/${mangaId}`),
      this.api.getTaxonomy().catch(() => ({ genres: [], sources: [] as SourceDto[] })),
    ]);

    const genres = (data.genres ?? []).map((genre) =>
      App.createTag({ id: `genre:${genre.genre_id}`, label: genre.genre_name }),
    );
    const tags = (data.tags ?? [])
      .slice(0, 60)
      .map((tag) => App.createTag({ id: `tag:${tag.tag_id}`, label: tag.tag_name }));

    const staff = data.series_staff ?? [];
    const author = staff.find((entry) => /author|story|writer|original creator/i.test(entry.role));
    const artist = staff.find((entry) => /art|illustrat/i.test(entry.role));
    const source = taxonomy.sources.find((entry) => entry.source_id === data.source_id);
    const covers = data.series_covers ?? [];
    const cover = covers.find((entry) => entry.is_main) ?? covers[0];

    return App.createSourceManga({
      id: mangaId,
      mangaInfo: App.createMangaInfo({
        titles: [
          data.title,
          ...(data.series_alternate_titles ?? []).map((alt) => alt.title).filter(Boolean),
        ],
        image: this.cover(domain, cover?.image_id),
        desc: (data.description ?? "").trim(),
        status: this.status(data),
        hentai: data.is_pornographic === true,
        ...(author?.name ? { author: author.name } : {}),
        ...(artist?.name ? { artist: artist.name } : {}),
        ...(source ? { additionalInfo: { source: source.title } } : {}),
        ...(genres.length > 0 || tags.length > 0
          ? {
              tags: [
                ...(genres.length > 0
                  ? [App.createTagSection({ id: "genres", label: "Genres", tags: genres })]
                  : []),
                ...(tags.length > 0
                  ? [App.createTagSection({ id: "tags", label: "Tags", tags })]
                  : []),
              ],
            }
          : {}),
      }),
    });
  }

  private status(data: DetailsDto): string {
    const value = `${data.upload_status ?? ""} ${data.publication_status ?? ""}`;

    if (/completed/i.test(value)) {
      return "Completed";
    }

    if (/abandoned/i.test(value)) {
      return "Dropped";
    }

    if (/hiatus/i.test(value)) {
      return "Hiatus";
    }

    return "Ongoing";
  }

  // The index lists every chapter in one payload as rows under a column list,
  // which is how the site itself fills the chapter list.
  async getChapters(mangaId: string): Promise<Chapter[]> {
    const data = await this.api.fetchJSON<BookIndexDto>(
      `/series/${mangaId}/books/index?fields=List`,
    );

    const columns = new Map(data.fields.map((name, index) => [name, index]));
    const column = (row: unknown[], name: string): unknown => {
      const index = columns.get(name);

      return index === undefined ? undefined : row[index];
    };
    const rows = data.books ?? [];

    if (rows.length === 0 || !columns.has("book_id")) {
      throw new Error(`No chapters were listed for ${mangaId}.`);
    }

    const groups = data.groups ?? [];
    const books = rows
      .map((row) => ({
        id: String(column(row, "book_id") ?? ""),
        sortNo: Number(column(row, "sort_no")),
        chapterNo: numberOrNaN(column(row, "chapter_no")),
        volumeNo: numberOrNaN(column(row, "volume_no")),
        title: String(column(row, "title") ?? "").trim(),
        releasedAt: Number(column(row, "released_at")),
        groupNames: (Array.isArray(column(row, "group_ix"))
          ? (column(row, "group_ix") as number[])
          : []
        )
          .map((index) => groups[index]?.title ?? "")
          .filter(Boolean),
      }))
      .filter((book) => book.id)
      .sort((left, right) => left.sortNo - right.sortNo);

    return books.map((book, index) => {
      const groupName = book.groupNames.join(", ");
      const chapNum = Number.isFinite(book.chapterNo) ? book.chapterNo : book.sortNo;
      // Titles like "Ch. 12" or "Chapter 12" only repeat the number.
      const name = /^(ch\.?|chapter)\s*[\d.]+$/i.test(book.title) ? "" : book.title;

      return App.createChapter({
        id: book.id,
        chapNum,
        sortingIndex: index,
        langCode: "en",
        ...(name ? { name } : {}),
        ...(Number.isFinite(book.volumeNo) ? { volume: book.volumeNo } : {}),
        ...(groupName ? { group: groupName } : {}),
        ...(Number.isFinite(book.releasedAt) && book.releasedAt > 0
          ? { time: new Date(book.releasedAt * 1000) }
          : {}),
      });
    });
  }

  // Pages come from the CDN the challenge names, as JPEG on the plain "page"
  // route; "page/original" would be JPEG XL, which the app cannot decode.
  async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
    const challenge = await this.api.challenge(chapterId);
    const base = challenge.cache_url.replace(/\/+$/, "");
    const pages = [...(challenge.manifest?.pages ?? [])]
      .sort((left, right) => left.page_no - right.page_no)
      .map(
        (page) =>
          `${base}/api/v2/books/page/${chapterId}/${page.page_id}.${page.ext ?? "jxl"}?token=${encodeURIComponent(challenge.access_token)}`,
      );

    if (pages.length === 0) {
      throw new Error(`No pages were listed for ${chapterId}.`);
    }

    return App.createChapterDetails({ id: chapterId, mangaId, pages });
  }
}

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
  PagedResults,
  PartialSourceManga,
  Request,
  RequestManager,
  SearchRequest,
  SearchResultsProviding,
  SourceInfo,
  SourceIntents,
  SourceManga,
  Tag,
  TagSection,
} from "@paperback/types";

import { isCloudflareChallenge, MangaballApi, originOf } from "./api";
import {
  ADULT_MODES,
  COVER_CDN,
  DEMOGRAPHICS,
  DOMAIN,
  HEX_ID,
  HOME_ROWS,
  ORIGIN_LABELS,
  PAGE_SIZE,
  PLACEHOLDER_COVER,
  SORT_FIELDS,
  STATUSES,
  TYPES,
  type ApiChapter,
  type ApiChapterDetail,
  type ApiImage,
  type ApiList,
  type ApiPagination,
  type ApiTitle,
  type HomeRow,
} from "./models";
import { buildSettings } from "./settings";
import {
  getAdultMode,
  getChallengeHost,
  getLanguageSetting,
  getTagMatchAll,
  isLanguageAllowed,
  setChallengeHost,
} from "./state";

export const MangaballInfo: SourceInfo = {
  version: "1.0.0",
  name: "Mangaball",
  icon: "icon.png",
  author: "kittycatgit",
  authorWebsite: "https://github.com/kittycatgit",
  description: "Extension that pulls content from mangaball.com.",
  contentRating: ContentRating.ADULT,
  websiteBaseURL: DOMAIN,
  language: "multi",
  intents:
    SourceIntents.MANGA_CHAPTERS |
    SourceIntents.HOMEPAGE_SECTIONS |
    SourceIntents.SETTINGS_UI |
    SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
};

export class Mangaball
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
      // The cover and page CDNs answer 403 unless the site is the referer.
      interceptRequest: async (request: Request): Promise<Request> => {
        request.headers = {
          ...request.headers,
          "user-agent": await this.requestManager.getDefaultUserAgent(),
          referer: `${DOMAIN}/`,
          accept: request.url.includes("/api/v1/") ? "application/json" : "*/*",
          "accept-language": "en-US,en;q=0.9",
        };

        return request;
      },
      interceptResponse: async (response) => {
        // Each CDN host is its own Cloudflare zone, so the bypass has to be
        // pointed at whichever host challenged.
        if (isCloudflareChallenge(response)) {
          await setChallengeHost(originOf(response.request.url));
        }

        return response;
      },
    },
  });

  private readonly api = new MangaballApi(this.requestManager);

  async getCloudflareBypassRequestAsync(): Promise<Request> {
    const challenged = await getChallengeHost();

    return App.createRequest({
      url: `${challenged || DOMAIN}/`,
      method: "GET",
      headers: {
        referer: `${DOMAIN}/`,
        "user-agent": await this.requestManager.getDefaultUserAgent(),
      },
    });
  }

  async getSourceMenu(): Promise<DUISection> {
    return buildSettings();
  }

  getMangaShareUrl(mangaId: string): string {
    return `${DOMAIN}/title-detail/${HEX_ID.exec(mangaId)?.[0] ?? mangaId}`;
  }

  // ---- discover -----------------------------------------------------------

  private row(entry: HomeRow, items?: PartialSourceManga[]): HomeSection {
    return App.createHomeSection({
      id: entry.id,
      title: entry.title,
      type: entry.type,
      containsMoreItems: entry.paged,
      ...(items ? { items } : {}),
    });
  }

  private async rowItems(entry: HomeRow, page: number): Promise<PartialSourceManga[]> {
    const { results } = await this.listing(entry, page);

    return results;
  }

  private async listing(
    entry: HomeRow,
    page: number,
  ): Promise<{ results: PartialSourceManga[]; pagination?: ApiPagination }> {
    const query = [
      entry.query,
      `limit=${entry.limit}`,
      entry.paged ? `page=${page}` : undefined,
      `adult_mode=${await getAdultMode()}`,
    ]
      .filter(Boolean)
      .join("&");

    const response = await this.api.getJson<ApiList<ApiTitle>>(entry.path, query);
    const titles = (response.data ?? []).filter((title) => titleId(title) && title.name);

    return {
      results: titles.map((title) => this.card(title, entry.id === "latest")),
      ...(response.pagination ? { pagination: response.pagination } : {}),
    };
  }

  // Every row is fetched together rather than one after another; a row that
  // fails stays empty so the others still paint.
  async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
    for (const entry of HOME_ROWS) {
      sectionCallback(this.row(entry));
    }

    const rows = await Promise.all(
      HOME_ROWS.map((entry) => this.rowItems(entry, 1).catch(() => [] as PartialSourceManga[])),
    );

    HOME_ROWS.forEach((entry, index) => {
      sectionCallback(this.row(entry, rows[index] ?? []));
    });

    // The rows are painted; pull the tag list in behind them so the filter
    // sheet opens without a wait.
    this.api.warm();
  }

  async getViewMoreItems(homepageSectionId: string, metadata: unknown): Promise<PagedResults> {
    const entry = HOME_ROWS.find((row) => row.id === homepageSectionId);

    if (!entry?.paged) {
      return App.createPagedResults({ results: [] });
    }

    const state = metadata as { page?: number; firstId?: string } | undefined;
    const page = state?.page ?? 1;
    const { results, pagination } = await this.listing(entry, page);

    // A listing that stops paginating hands back its first page again; the
    // first id tells that apart from a real next page.
    const firstId = results[0]?.mangaId;
    if (state?.firstId && state.firstId === firstId) {
      return App.createPagedResults({ results: [] });
    }

    const more = pagination ? hasMore(pagination, page) : results.length >= entry.limit;

    return App.createPagedResults({
      results,
      metadata: more ? { page: page + 1, ...(firstId ? { firstId } : {}) } : undefined,
    });
  }

  // ---- search -------------------------------------------------------------

  // Tag ids carry the group they came from so the search query can put each one
  // in the right field; ids never contain spaces, which Paperback rejects.
  async getSearchTags(): Promise<TagSection[]> {
    const groups = await this.api.getTagGroups();

    const sections: TagSection[] = [
      App.createTagSection({
        id: "sort",
        label: "Sort",
        tags: SORT_FIELDS.map((sort) =>
          App.createTag({ id: `sort:${sort.id}`, label: sort.title }),
        ),
      }),
      ...groups.map((group) =>
        App.createTagSection({
          id: group.id,
          label: group.title,
          tags: group.tags.map((tag) => App.createTag({ id: `tag:${tag.id}`, label: tag.title })),
        }),
      ),
      App.createTagSection({
        id: "status",
        label: "Status",
        tags: STATUSES.map((status) =>
          App.createTag({ id: `status:${status.id}`, label: status.title }),
        ),
      }),
      App.createTagSection({
        id: "type",
        label: "Publication Type",
        tags: TYPES.map((type) => App.createTag({ id: `type:${type.id}`, label: type.title })),
      }),
      App.createTagSection({
        id: "demographic",
        label: "Demographic",
        tags: DEMOGRAPHICS.map((entry) =>
          App.createTag({ id: `demographic:${entry.id}`, label: entry.title }),
        ),
      }),
      App.createTagSection({
        id: "adult",
        label: "Content Rating",
        tags: ADULT_MODES.map((mode) =>
          App.createTag({ id: `adult:${mode.id}`, label: mode.title }),
        ),
      }),
    ];

    return sections.filter((section) => (section.tags?.length ?? 0) > 0);
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

  async getSearchResults(query: SearchRequest, metadata: unknown): Promise<PagedResults> {
    const page = (metadata as { page?: number } | undefined)?.page ?? 1;
    const params: string[] = [];
    const add = (key: string, value: string | undefined): void => {
      if (value) {
        params.push(`${key}=${encodeURIComponent(value)}`);
      }
    };

    const title = query.title?.trim();
    add("keyword", title);

    const included = this.split(query.includedTags, "tag");
    const excluded = this.split(query.excludedTags, "tag");
    add("included_tags", included.join(","));
    add("excluded_tags", excluded.join(","));
    add("tag_mode", included.length > 1 && !(await getTagMatchAll()) ? "OR" : undefined);
    add("status", this.split(query.includedTags, "status")[0]);
    add("type", this.split(query.includedTags, "type")[0]);
    add("publicationDemographic", this.split(query.includedTags, "demographic")[0]);
    add("adult_mode", this.split(query.includedTags, "adult")[0] ?? (await getAdultMode()));

    // A keyword search is ranked by relevance only while no sort is sent; a
    // filter-only browse needs one or the catalogue arrives in storage order.
    const sort = this.split(query.includedTags, "sort")[0] ?? (title ? undefined : "lastupdate");
    add("sort_by", sort);
    add("sort_order", sort ? (sort === "name" ? "asc" : "desc") : undefined);
    params.push(`page=${page}`, `limit=${PAGE_SIZE}`);

    const response = await this.api.getJson<ApiList<ApiTitle>>(
      "title/search-advanced",
      params.join("&"),
    );
    const titles = (response.data ?? []).filter((entry) => titleId(entry) && entry.name);

    return App.createPagedResults({
      results: titles.map((entry) => this.card(entry)),
      metadata: hasMore(response.pagination, page) ? { page: page + 1 } : undefined,
    });
  }

  // ---- manga --------------------------------------------------------------

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const id = HEX_ID.exec(mangaId)?.[0] ?? mangaId;
    const response = await this.api.getJson<{ data?: ApiTitle }>(`title/detail/${id}`);
    const title = response.data;

    if (!title?.name) {
      throw new Error(`Title ${id} was not found`);
    }

    const tagSections: TagSection[] = [];
    for (const group of await this.api.getTagGroups()) {
      const tags = (title.tags ?? [])
        .filter((tag) => tag.group === group.id && tag.id && tag.name)
        .map((tag) => App.createTag({ id: `tag:${tag.id}`, label: tag.name }));

      if (tags.length > 0) {
        tagSections.push(App.createTagSection({ id: group.id, label: group.title, tags }));
      }
    }

    const people = title.authors?.length ? title.authors : (title.author ?? []);
    const authors = people.filter(
      (person) => !person.roles?.length || person.roles.includes("author"),
    );
    const artists = people.filter((person) => person.roles?.includes("artist"));

    const additionalInfo: Record<string, string> = {};
    const origin = title.originalLanguage ? ORIGIN_LABELS[title.originalLanguage] : undefined;
    if (origin) {
      additionalInfo["Type"] = origin;
    }
    if (title.publicationDemographic) {
      additionalInfo["Demographic"] = capitalize(title.publicationDemographic);
    }
    if (title.date_published) {
      additionalInfo["Year"] = String(title.date_published);
    }
    const chapterCount = title.chapters_count ?? title.stats?.chapters;
    if (chapterCount) {
      additionalInfo["Chapters"] = String(chapterCount);
    }
    if (title.stats?.views) {
      additionalInfo["Views"] = title.stats.views.toLocaleString("en-US");
    }
    if (title.stats?.followers) {
      additionalInfo["Followers"] = String(title.stats.followers);
    }
    if (title.availableTranslatedLanguages?.length) {
      additionalInfo["Languages"] = title.availableTranslatedLanguages.join(", ");
    }
    const average = title.ratings?.rating_average;
    if (average && title.ratings?.total_rating) {
      additionalInfo["Rating"] = `${average} / 10 (${title.ratings.total_rating} votes)`;
    }

    const titles = [title.name];
    for (const alternate of title.alternateName ?? []) {
      if (alternate && !titles.includes(alternate)) {
        titles.push(alternate);
      }
    }

    return App.createSourceManga({
      id: mangaId,
      mangaInfo: App.createMangaInfo({
        titles,
        image: coverUrl(title.image),
        desc: synopsis(title),
        status: status(title.status),
        hentai: title.is18plus === true,
        ...(authors.length > 0 ? { author: authors.map((person) => person.name).join(", ") } : {}),
        ...(artists.length > 0 ? { artist: artists.map((person) => person.name).join(", ") } : {}),
        // The site rates out of ten and the app's stars go to five.
        ...(average ? { rating: average / 2 } : {}),
        ...(tagSections.length > 0 ? { tags: tagSections } : {}),
        ...(Object.keys(additionalInfo).length > 0 ? { additionalInfo } : {}),
      }),
    });
  }

  async getChapters(mangaId: string): Promise<Chapter[]> {
    const id = HEX_ID.exec(mangaId)?.[0] ?? mangaId;
    const setting = await getLanguageSetting();
    const language = setting.includes("all") ? "all" : setting.join(",");

    const rows: ApiChapter[] = [];
    for (let page = 1; ; page++) {
      const response = await this.api.getJson<ApiList<ApiChapter>>(
        "title/chapter-listing",
        `title_id=${id}&page=${page}&limit=1000&group_by=flat&sort_order=desc&language=${encodeURIComponent(language)}`,
      );
      rows.push(...(response.data ?? []));

      if (!response.pagination || !hasMore(response.pagination, page)) {
        break;
      }
    }

    const seen = new Set<string>();
    const chapters = rows
      .filter((row) => {
        if (!row.id || seen.has(row.id) || !isLanguageAllowed(setting, row.lang ?? "")) {
          return false;
        }
        seen.add(row.id);

        return true;
      })
      .map((row) => {
        const number = Number(row.number ?? row.chapter_number ?? 0);

        return { row, chapNum: Number.isFinite(number) ? number : 0 };
      })
      .sort((left, right) => left.chapNum - right.chapNum);

    if (chapters.length === 0) {
      throw new Error(`No chapters were listed for ${id}`);
    }

    return chapters.map(({ row, chapNum }, index) => {
      const published = row.created_at ? new Date(row.created_at) : undefined;
      const group = row.group_name ?? row.group?.name;

      return App.createChapter({
        id: row.id,
        chapNum,
        sortingIndex: index,
        langCode: (row.lang ?? "").trim() || "en",
        ...(row.name ? { name: row.name } : {}),
        ...(row.volume ? { volume: row.volume } : {}),
        ...(group ? { group } : {}),
        ...(published && !isNaN(published.getTime()) ? { time: published } : {}),
      });
    });
  }

  async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
    const response = await this.api.getJson<ApiChapterDetail>(
      "chapter-detail",
      `chapter_id=${encodeURIComponent(chapterId)}&user_id=demo_user`,
    );
    const pages = (response.data?.chapter?.pages ?? []).filter((page) => /^https?:/.test(page));

    if (pages.length === 0) {
      throw new Error(`No pages were returned for chapter ${chapterId}`);
    }

    return App.createChapterDetails({ id: chapterId, mangaId, pages });
  }

  // ---- cards --------------------------------------------------------------

  private card(title: ApiTitle, withLanguage = false): PartialSourceManga {
    const subtitle = cardSubtitle(title, withLanguage);

    return App.createPartialSourceManga({
      mangaId: titleId(title),
      title: title.name,
      image: coverUrl(title.image),
      ...(subtitle ? { subtitle } : {}),
    });
  }
}

function titleId(title: ApiTitle): string {
  return title.id ?? title._id ?? "";
}

// What the site prints under a card: the newest chapter, else the count.
function cardSubtitle(title: ApiTitle, withLanguage: boolean): string {
  const recent = title.recent_chapters?.[0];
  const latest = title.latest_chapter ?? recent?.number;
  const parts: string[] = [];

  if (latest !== undefined && latest !== null && latest !== "") {
    parts.push(`Ch. ${latest}`);
  } else if (title.stats?.chapters) {
    parts.push(`${title.stats.chapters} chapters`);
  }

  // The updates row is the one place the site names the language of the
  // chapter it just listed.
  if (withLanguage && recent?.lang) {
    parts.push(recent.lang.toUpperCase());
  } else {
    const origin = title.originalLanguage ? ORIGIN_LABELS[title.originalLanguage] : undefined;
    if (origin) {
      parts.push(origin);
    }
  }

  if (parts.length === 0 && title.status) {
    parts.push(capitalize(title.status));
  }

  return parts.join(" · ");
}

// Same order the site's own getTitleImage uses. Some titles carry no cover at
// all, and the fallback has to be a URL the app can try: an empty string
// blanks the whole row.
function coverUrl(image: ApiImage | null | undefined): string {
  const path = image?.cover?.path?.trim();

  if (path) {
    return /^https?:\/\//.test(path) ? path : `${COVER_CDN}${path.replace(/^\/+/, "")}`;
  }

  for (const candidate of [
    image?.cdn_mangadex,
    image?.cdn_mangaupdates,
    image?.cdn_mangaupdate,
    image?.file,
  ]) {
    const url = candidate?.trim();

    if (url?.startsWith("https://")) {
      return url;
    }
  }

  return PLACEHOLDER_COVER;
}

function synopsis(title: ApiTitle): string {
  const description = title.description;
  const text = Array.isArray(description) ? description.join("\n\n") : (description ?? "");

  return text.replace(/<[^>]+>/g, "").trim();
}

function status(value: string | null | undefined): string {
  const text = (value ?? "").toLowerCase();

  if (text.includes("complet")) {
    return "Completed";
  }

  if (text.includes("hiatus")) {
    return "Hiatus";
  }

  if (text.includes("cancel") || text.includes("drop")) {
    return "Dropped";
  }

  return text ? "Ongoing" : "Unknown";
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ") : value;
}

function hasMore(pagination: ApiPagination | undefined, page: number): boolean {
  return (pagination?.total_pages ?? page) > page;
}

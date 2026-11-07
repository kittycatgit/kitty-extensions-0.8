/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 kittycatgit */

import { CheerioAPI } from "cheerio";
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
  TagSection,
} from "@paperback/types";

import { ADULT_GENRES, GENRES } from "./genres";

const DOMAIN = "https://fanfox.net";
const MOBILE_DOMAIN = "https://m.fanfox.net";

// Every list URL below is slash-terminated or has a query: without that the site 301s to plain http, which iOS refuses.
// Every block of the site's home page, in the site's order. Text-only blocks (ranking, trending) have no covers on
// the home page, so those rails are fed from their own listing pages; "Completed" is the directory's completed view.
type HomeEntry = {
  id: string;
  title: string;
  type: HomeSectionType;
  heading?: string; // the block's heading on the home page
  page?: (page: number) => string; // the listing page behind "more", if any
  paged?: boolean;
};
const HOME_SECTIONS: HomeEntry[] = [
  {
    id: "hot",
    title: "Hot Manga Releases",
    type: HomeSectionType.featured,
    heading: "Hot Manga Releases",
    page: () => `${DOMAIN}/hot/`,
  },
  {
    id: "reading",
    title: "Being Read Right Now",
    type: HomeSectionType.singleRowNormal,
    heading: "Being Read Right Now",
  },
  {
    id: "ranking",
    title: "Popular Manga Ranking",
    type: HomeSectionType.singleRowNormal,
    page: () => `${DOMAIN}/ranking/`,
  },
  {
    id: "recommended",
    title: "Recommended",
    type: HomeSectionType.singleRowNormal,
    heading: "Recommended",
  },
  {
    id: "new",
    title: "New Manga Release",
    type: HomeSectionType.singleRowNormal,
    heading: "New Manga Release",
    page: (n) => (n > 1 ? `${DOMAIN}/directory/${n}.html?news` : `${DOMAIN}/directory/?news`),
    paged: true,
  },
  {
    id: "latest",
    title: "Latest Updates",
    type: HomeSectionType.singleRowLarge,
    heading: "Updates",
    page: (n) => (n > 1 ? `${DOMAIN}/releases/${n}.html` : `${DOMAIN}/releases/`),
    paged: true,
  },
  {
    id: "trending",
    title: "Trending Manga",
    type: HomeSectionType.singleRowNormal,
    page: () => `${DOMAIN}/trending/`,
  },
  {
    id: "completed",
    title: "Completed",
    type: HomeSectionType.singleRowNormal,
    page: (n) =>
      n > 1 ? `${DOMAIN}/directory/${n}.html?complete` : `${DOMAIN}/directory/?complete`,
    paged: true,
  },
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export const MangaFoxInfo: SourceInfo = {
  version: "2.0.0",
  name: "MangaFox",
  icon: "icon.png",
  author: "kittycatgit",
  authorWebsite: "https://github.com/kittycatgit",
  description: "Extension that pulls content from fanfox.net.",
  contentRating: ContentRating.MATURE,
  websiteBaseURL: DOMAIN,
  language: "en",
  intents:
    SourceIntents.MANGA_CHAPTERS |
    SourceIntents.HOMEPAGE_SECTIONS |
    SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
};

export class MangaFox
  implements
    ChapterProviding,
    SearchResultsProviding,
    HomePageSectionsProviding,
    CloudflareBypassRequestProviding,
    MangaProviding
{
  constructor(public cheerio: CheerioAPI) {}

  readonly requestManager: RequestManager = App.createRequestManager({
    requestsPerSecond: 4,
    requestTimeout: 20_000,
    interceptor: {
      // Mutated in place as well as returned: the image CDN answers 403 without a fanfox referer.
      interceptRequest: async (request: Request): Promise<Request> => {
        request.headers = {
          ...request.headers,
          referer: `${DOMAIN}/`,
          "user-agent": await this.requestManager.getDefaultUserAgent(),
        };
        const host = /^https?:\/\/([^/]+)/.exec(request.url)?.[1] ?? "fanfox.net";
        request.cookies = [
          ...(request.cookies ?? []).filter((cookie) => cookie.name !== "isAdult"),
          App.createCookie({ name: "isAdult", value: "1", domain: host }),
        ];

        return request;
      },
      interceptResponse: async (response: Response): Promise<Response> => {
        if (this.isCloudflareChallenge(response)) {
          throw new Error("CLOUDFLARE BYPASS ERROR");
        }

        return response;
      },
    },
  });

  private isCloudflareChallenge(response: Response): boolean {
    const headers = response.headers ?? {};
    const mitigated = String(headers["cf-mitigated"] ?? headers["Cf-Mitigated"] ?? "");

    if (mitigated.toLowerCase() === "challenge") {
      return true;
    }

    return (
      (response.status === 403 || response.status === 503) &&
      /just a moment|cf-chl|challenge-platform/i.test(response.data ?? "")
    );
  }

  async getCloudflareBypassRequestAsync(): Promise<Request> {
    return App.createRequest({
      url: `${DOMAIN}/`,
      method: "GET",
      headers: {
        referer: `${DOMAIN}/`,
        "user-agent": await this.requestManager.getDefaultUserAgent(),
      },
    });
  }

  getMangaShareUrl(mangaId: string): string {
    return `${DOMAIN}/manga/${mangaId}/`;
  }

  private async fetch(url: string): Promise<CheerioAPI> {
    const response = await this.requestManager.schedule(
      App.createRequest({ url, method: "GET" }),
      1,
    );

    if (response.status !== 200) {
      throw new Error(`${url} answered ${response.status}.`);
    }

    return this.cheerio.load(response.data ?? "");
  }

  // Covers come as plain http or protocol-relative; the CDN serves https and the app refuses http.
  private https(url: string | undefined): string {
    return (url ?? "")
      .trim()
      .replace(/^http:\/\//, "https://")
      .replace(/^\/\//, "https://");
  }

  private mangaIdOf(href: string | undefined): string {
    return /\/manga\/([^/?#]+)/.exec(href ?? "")?.[1] ?? "";
  }

  private pushTile(
    tiles: PartialSourceManga[],
    seen: Set<string>,
    tile: { mangaId: string; title: string; image: string; subtitle?: string },
  ): void {
    if (!tile.mangaId || !tile.title || !tile.image || seen.has(tile.mangaId)) {
      return;
    }

    seen.add(tile.mangaId);
    tiles.push(
      App.createPartialSourceManga({
        ...tile,
        ...(tile.subtitle ? { subtitle: tile.subtitle } : {}),
      }),
    );
  }

  // Cover grids on the home page, /hot/ and /directory/.
  private list1Tiles($: CheerioAPI, root: unknown): PartialSourceManga[] {
    const tiles: PartialSourceManga[] = [];
    const seen = new Set<string>();

    for (const element of $(
      "ul.manga-list-1-list > li, ul.manga-list-3-list > li",
      root as string,
    ).toArray()) {
      const link = $('a[href^="/manga/"]', element).first();
      this.pushTile(tiles, seen, {
        mangaId: this.mangaIdOf(link.attr("href")),
        title: (link.attr("title") ?? "").trim(),
        image: this.https($("img.manga-list-1-cover", element).attr("src")),
        subtitle: $("p.manga-list-1-item-subtitle", element).text().trim(),
      });
    }

    return tiles;
  }

  // Row lists on /releases/ and /search.
  private list4Tiles($: CheerioAPI): PartialSourceManga[] {
    const tiles: PartialSourceManga[] = [];
    const seen = new Set<string>();

    for (const element of $("ul.manga-list-4-list > li").toArray()) {
      const link = $("p.manga-list-4-item-title a", element).first();
      const latest =
        $("ul.manga-list-4-item-part > li", element).first().text().trim() ||
        $("p.manga-list-4-item-tip", element)
          .filter((_, tip) => $(tip).text().includes("Latest Chapter"))
          .find("a")
          .first()
          .text()
          .trim();

      this.pushTile(tiles, seen, {
        mangaId: this.mangaIdOf(link.attr("href")),
        title: (link.attr("title") ?? link.text()).trim(),
        image: this.https($("img.manga-list-4-cover", element).attr("src")),
        subtitle: latest,
      });
    }

    return tiles;
  }

  // The ">" pager link is a real path when another page exists and javascript:void(0) on the last one.
  private hasNextPage($: CheerioAPI): boolean {
    return $(".pager-list-left a")
      .toArray()
      .some(
        (element) =>
          $(element).text().trim() === ">" && ($(element).attr("href") ?? "").startsWith("/"),
      );
  }

  private paged(tiles: PartialSourceManga[], $: CheerioAPI, page: number): PagedResults {
    return App.createPagedResults({
      results: tiles,
      metadata: this.hasNextPage($) ? { page: page + 1 } : undefined,
    });
  }

  async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
    for (const entry of HOME_SECTIONS) {
      sectionCallback(this.section(entry));
    }

    const home = this.fetch(`${DOMAIN}/`);
    // Each rail fills on its own: one failing listing page must not take the others down with it.
    await Promise.all(
      HOME_SECTIONS.map(async (entry) => {
        try {
          const items = entry.heading
            ? this.homeBlock(await home, entry)
            : this.list1Tiles(await this.fetch(entry.page!(1)), undefined);
          sectionCallback(this.section(entry, items));
        } catch (e) {
          console.log(`MangaFox: rail ${entry.id} failed: ${String(e)}`);
        }
      }),
    );
  }

  private section(entry: HomeEntry, items?: PartialSourceManga[]): HomeSection {
    return App.createHomeSection({
      id: entry.id,
      title: entry.title,
      type: entry.type,
      containsMoreItems: !!entry.page,
      ...(items ? { items } : {}),
    });
  }

  // The home page block with this heading ("Lastest Updates" is the site's spelling, so "Updates" matches it).
  private homeBlock($: CheerioAPI, entry: HomeEntry): PartialSourceManga[] {
    const block = $("div.manga-list-1, div.manga-list-3, div.manga-list-4")
      .filter((_, element) =>
        $("div.manga-list-1-title, div.manga-list-3-title, div.manga-list-4-title", element)
          .first()
          .text()
          .includes(entry.heading!),
      )
      .first();
    return entry.id === "latest"
      ? this.list4Tiles(this.cheerio.load($.html(block)))
      : this.list1Tiles($, block);
  }

  async getViewMoreItems(homepageSectionId: string, metadata: unknown): Promise<PagedResults> {
    const page = (metadata as { page?: number } | undefined)?.page ?? 1;
    const entry = HOME_SECTIONS.find((e) => e.id === homepageSectionId);
    if (!entry?.page) return App.createPagedResults({ results: [] });
    const $ = await this.fetch(entry.page(page));
    const tiles = entry.id === "latest" ? this.list4Tiles($) : this.list1Tiles($, undefined);
    return entry.paged ? this.paged(tiles, $, page) : App.createPagedResults({ results: tiles });
  }

  async getSearchTags(): Promise<TagSection[]> {
    return [
      App.createTagSection({
        id: "genres",
        label: "Genres",
        tags: GENRES.map((genre) => App.createTag({ id: genre.id, label: genre.name })),
      }),
    ];
  }

  async supportsTagExclusion(): Promise<boolean> {
    return true;
  }

  async getSearchResults(query: SearchRequest, metadata: unknown): Promise<PagedResults> {
    const page = (metadata as { page?: number } | undefined)?.page ?? 1;
    const params = [`title=${encodeURIComponent((query.title ?? "").trim())}`];
    const included = (query.includedTags ?? []).map((tag) => tag.id).join(",");
    const excluded = (query.excludedTags ?? []).map((tag) => tag.id).join(",");

    if (included) params.push(`genres=${included}`);
    if (excluded) params.push(`nogenres=${excluded}`);
    if (page > 1) params.push(`page=${page}`);

    const $ = await this.fetch(`${DOMAIN}/search?${params.join("&")}`);

    return this.paged(this.list4Tiles($), $, page);
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const $ = await this.fetch(this.getMangaShareUrl(mangaId));
    const info = $(".detail-info");
    const title = $(".detail-info-right-title-font", info).text().trim();
    const rating = Number($(".detail-info-right-title-star .item-score", info).text().trim());
    const author = $(".detail-info-right-say a", info).first().text().trim();
    const status = /completed/i.test($(".detail-info-right-title-tip", info).text())
      ? "Completed"
      : "Ongoing";
    const desc = ($("p.fullcontent").text() || $(".detail-info-right-content", info).text())
      .replace(/\s*more$/, "")
      .trim();

    // Detail pages link genres by slug; search takes the numeric id, so tags carry the latter.
    const tags = $(".detail-info-right-tag-list a", info)
      .toArray()
      .map((element) => $(element).text().trim())
      .filter((label) => label.length > 0)
      .map((label) => {
        const known = GENRES.find((genre) => genre.name.toLowerCase() === label.toLowerCase());
        return App.createTag({
          id: known?.id ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          label,
        });
      });
    const labels = tags.map((tag) => tag.label);

    return App.createSourceManga({
      id: mangaId,
      mangaInfo: App.createMangaInfo({
        titles: [title || mangaId],
        image: this.https($(".detail-info-cover-img", info).attr("src")),
        desc,
        status,
        hentai: ADULT_GENRES.some((genre) => labels.includes(genre)),
        ...(author ? { author, artist: author } : {}),
        ...(rating > 0 ? { rating } : {}),
        ...(tags.length > 0
          ? { tags: [App.createTagSection({ id: "genres", label: "Genres", tags })] }
          : {}),
      }),
    });
  }

  private parseDate(text: string): Date | undefined {
    const value = text.trim();
    const upper = value.toUpperCase();

    if (upper === "TODAY" || /AGO|JUST NOW|LESS THAN AN HOUR/.test(upper)) {
      const count = Number(/\d+/.exec(upper)?.[0] ?? 0);
      const spans: Record<string, number> = {
        SECOND: 1_000,
        MINUTE: 60_000,
        HOUR: 3_600_000,
        DAY: 86_400_000,
        WEEK: 604_800_000,
        MONTH: 2_629_800_000,
        YEAR: 31_557_600_000,
      };
      const unit = Object.keys(spans).find((key) => upper.includes(key));
      return new Date(Date.now() - (unit ? count * spans[unit]! : 0));
    }

    if (upper === "YESTERDAY") {
      return new Date(Date.now() - 86_400_000);
    }

    // "Oct 24,2026": parsed by hand since the app's JS engine is not V8.
    const match = /^([A-Za-z]{3})\w*\s+(\d{1,2}),\s*(\d{4})$/.exec(value);
    if (match) {
      const month = MONTHS.indexOf(match[1]!.toLowerCase());
      if (month >= 0) {
        return new Date(Date.UTC(Number(match[3]), month, Number(match[2])));
      }
    }

    return undefined;
  }

  async getChapters(mangaId: string): Promise<Chapter[]> {
    const $ = await this.fetch(this.getMangaShareUrl(mangaId));
    const rows: { id: string; chapNum: number; volume?: number; time?: Date }[] = [];
    const seen = new Set<string>();

    for (const element of $("div#chapterlist ul li a").toArray()) {
      // The id keeps the volume segment ("v01/c131"): the reader URL does not resolve without it.
      const id = new RegExp(`/manga/${mangaId}/(.+?)/\\d+\\.html`).exec(
        $(element).attr("href") ?? "",
      )?.[1];

      if (!id || seen.has(id)) {
        continue;
      }

      seen.add(id);
      const volume = /(?:^|\/)v(\d+)/.exec(id)?.[1];
      rows.push({
        id,
        chapNum: Number(/c([0-9.]+)/.exec(id)?.[1] ?? 0) || 0,
        ...(volume ? { volume: Number(volume) } : {}),
        time: this.parseDate($("p.title2", element).text()),
      });
    }

    // The site lists newest first.
    return rows.map((row, index) =>
      App.createChapter({
        id: row.id,
        chapNum: row.chapNum,
        langCode: "en",
        sortingIndex: rows.length - index,
        ...(row.volume !== undefined ? { volume: row.volume } : {}),
        ...(row.time ? { time: row.time } : {}),
      }),
    );
  }

  // The mobile roll reader lists every page of the chapter in one document, where the desktop reader
  // hands out pages one scripted request at a time.
  async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
    const $ = await this.fetch(`${MOBILE_DOMAIN}/roll_manga/${mangaId}/${chapterId}/1.html`);
    const pages: string[] = [];

    for (const element of $("img[data-original]").toArray()) {
      const src = this.https($(element).attr("data-original"));
      if (/\/store\/manga\//.test(src) && !pages.includes(src)) {
        pages.push(src);
      }
    }

    if (pages.length === 0) {
      const notice = $(".also-like .alsotitle").text().trim();
      throw new Error(
        notice
          ? `${mangaId}/${chapterId}: ${notice}`
          : `No pages were found for ${mangaId}/${chapterId}.`,
      );
    }

    return App.createChapterDetails({ id: chapterId, mangaId, pages });
  }
}

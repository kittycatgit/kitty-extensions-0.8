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

const DOMAIN = "https://coffeemanga.net";
const PAGE_SIZE = 12;

// Titles and orderings come from the site's own home page rails and the
// "View all" link each one carries.
const HOME_SECTIONS = [
  { id: "popular_today", title: "Popular today", order: "trending" },
  { id: "latest_updates", title: "Latest updates", order: "latest" },
  { id: "new_series", title: "New Series", order: "new-manga" },
  { id: "most_read", title: "Most read", order: "views" },
] as const;

const FEATURED = { id: "featured", title: "Featured" };

export const CoffeeMangaInfo: SourceInfo = {
  version: "1.0.0",
  name: "CoffeeManga",
  icon: "icon.png",
  author: "kittycatgit",
  authorWebsite: "https://github.com/kittycatgit",
  description: "Extension that pulls content from coffeemanga.net.",
  contentRating: ContentRating.MATURE,
  websiteBaseURL: DOMAIN,
  language: "en",
  intents:
    SourceIntents.MANGA_CHAPTERS |
    SourceIntents.HOMEPAGE_SECTIONS |
    SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
};

export class CoffeeManga
  implements
    SearchResultsProviding,
    ChapterProviding,
    HomePageSectionsProviding,
    CloudflareBypassRequestProviding
{
  constructor(public cheerio: CheerioAPI) {}

  readonly requestManager: RequestManager = App.createRequestManager({
    requestsPerSecond: 4,
    requestTimeout: 20_000,
    interceptor: {
      interceptRequest: async (request: Request): Promise<Request> => {
        request.headers = {
          ...request.headers,
          referer: `${DOMAIN}/`,
          "user-agent": await this.requestManager.getDefaultUserAgent(),
        };

        return request;
      },
      interceptResponse: async (response) => response,
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
    return `${DOMAIN}/manga/${mangaId}/`;
  }

  private async fetch(url: string, method: "GET" | "POST" = "GET"): Promise<string> {
    const response = await this.requestManager.schedule(App.createRequest({ url, method }), 1);

    return typeof response.data === "string" ? response.data : String(response.data ?? "");
  }

  private decode(value: string): string {
    return value
      .replace(/<[^>]+>/g, "")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .trim();
  }

  private absolute(url: string): string {
    const trimmed = url.trim();

    if (trimmed.startsWith("//")) {
      return `https:${trimmed}`;
    }

    return (trimmed.startsWith("/") ? `${DOMAIN}${trimmed}` : trimmed).replace(
      /^http:\/\//,
      "https://",
    );
  }

  private slugOf(href: string): string {
    return (href ?? "").split("?")[0]?.replace(/\/$/, "").split("/").pop()?.trim() ?? "";
  }

  // Covers are served at several widths and `src` points at the smallest, so
  // take the widest candidate the srcset offers.
  private cover(node: ReturnType<CheerioAPI>): string {
    const srcset = (node.first().attr("srcset") ?? "").trim();

    if (srcset) {
      let best = "";
      let width = -1;

      for (const candidate of srcset.split(",")) {
        const [url, size] = candidate.trim().split(/\s+/);
        const parsed = Number((size ?? "").replace(/[^0-9]/g, ""));

        if (url && parsed > width) {
          best = url;
          width = parsed;
        }
      }

      if (best) {
        return this.absolute(best);
      }
    }

    for (const attribute of ["data-src", "data-lazy-src", "src"]) {
      const value = (node.first().attr(attribute) ?? "").trim();

      if (value && !value.startsWith("data:")) {
        return this.absolute(value);
      }
    }

    return `${DOMAIN}/favicon.ico`;
  }

  private ago(text: string): Date | undefined {
    const trimmed = text.trim();
    const match = /(\d+)\s*(second|minute|hour|day|week|month|year)/i.exec(trimmed);

    if (!match) {
      const parsed = new Date(trimmed);

      return trimmed && !isNaN(parsed.getTime()) ? parsed : undefined;
    }

    const spans: Record<string, number> = {
      second: 1_000,
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
      week: 604_800_000,
      month: 2_629_800_000,
      year: 31_557_600_000,
    };

    return new Date(Date.now() - Number(match[1]) * (spans[(match[2] ?? "").toLowerCase()] ?? 0));
  }

  private cards(html: string): PartialSourceManga[] {
    const $ = this.cheerio.load(html);
    const results: PartialSourceManga[] = [];
    const seen = new Set<string>();

    for (const element of $("a.acard").toArray()) {
      const slug = this.slugOf($(element).attr("href") ?? "");
      const title = this.decode(
        ($(element).attr("title") ?? "") || $(element).find("div.ac-t").first().text(),
      );

      // /manga/feed/ is WordPress' RSS endpoint, not a title.
      if (!slug || slug === "feed" || !title || seen.has(slug)) {
        continue;
      }

      seen.add(slug);

      const chapter = this.decode($(element).find("div.ac-ch").first().text());

      results.push(
        App.createPartialSourceManga({
          mangaId: slug,
          title,
          image: this.cover($(element).find("img")),
          ...(chapter ? { subtitle: chapter } : {}),
        }),
      );
    }

    return results;
  }

  // The hero is built from its own markup rather than the card grid, and its
  // artwork is a CSS background instead of an <img>.
  private heroTiles(html: string): PartialSourceManga[] {
    const $ = this.cheerio.load(html);
    const tiles: PartialSourceManga[] = [];
    const seen = new Set<string>();

    for (const element of $("div.hslide").toArray()) {
      const link = $(element).find("h2.htitle a, h3.htitle a").first();
      const slug = this.slugOf(link.attr("href") ?? "");
      const title = this.decode(link.text());

      if (!slug || slug === "feed" || !title || seen.has(slug)) {
        continue;
      }

      seen.add(slug);

      const style = $(element).find("div.hslide__bg").first().attr("style") ?? "";
      const image = /url\(\s*['"]?([^'")]+)/.exec(style)?.[1] ?? "";

      tiles.push(
        App.createPartialSourceManga({
          mangaId: slug,
          title,
          image: image ? this.absolute(image) : `${DOMAIN}/favicon.ico`,
        }),
      );
    }

    return tiles;
  }

  private listingUrl(options: { page: number; order?: string; genre?: string }): string {
    if (options.genre) {
      return `${DOMAIN}/manga-genre/${options.genre}/page/${options.page}/${
        options.order ? `?m_orderby=${options.order}` : ""
      }`;
    }

    return `${DOMAIN}/manga/page/${options.page}/?m_orderby=${options.order ?? "views"}`;
  }

  async getSearchTags(): Promise<TagSection[]> {
    const $ = this.cheerio.load(await this.fetch(`${DOMAIN}/?s=&post_type=wp-manga`));
    const tags: Tag[] = [];
    const seen = new Set<string>();

    for (const element of $('a[href*="/manga-genre/"]').toArray()) {
      const id = this.slugOf($(element).attr("href") ?? "");
      const label = this.decode($(element).text());

      if (id && label && !seen.has(id)) {
        seen.add(id);
        tags.push(App.createTag({ id, label }));
      }
    }

    tags.sort((left, right) => (left.label ?? "").localeCompare(right.label ?? ""));

    return tags.length > 0 ? [App.createTagSection({ id: "genres", label: "Genres", tags })] : [];
  }

  async supportsTagExclusion(): Promise<boolean> {
    return false;
  }

  async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
    sectionCallback(
      App.createHomeSection({
        id: FEATURED.id,
        title: FEATURED.title,
        type: HomeSectionType.singleRowLarge,
        containsMoreItems: false,
      }),
    );

    for (const entry of HOME_SECTIONS) {
      sectionCallback(
        App.createHomeSection({
          id: entry.id,
          title: entry.title,
          type: HomeSectionType.singleRowNormal,
          containsMoreItems: true,
        }),
      );
    }

    const home = await this.fetch(`${DOMAIN}/`);

    sectionCallback(
      App.createHomeSection({
        id: FEATURED.id,
        title: FEATURED.title,
        type: HomeSectionType.singleRowLarge,
        containsMoreItems: false,
        items: this.heroTiles(home),
      }),
    );

    for (const entry of HOME_SECTIONS) {
      sectionCallback(
        App.createHomeSection({
          id: entry.id,
          title: entry.title,
          type: HomeSectionType.singleRowNormal,
          containsMoreItems: true,
          items: this.cards(await this.fetch(this.listingUrl({ page: 1, order: entry.order }))),
        }),
      );
    }
  }

  async getViewMoreItems(homepageSectionId: string, metadata: unknown): Promise<PagedResults> {
    const entry = HOME_SECTIONS.find((row) => row.id === homepageSectionId);

    if (!entry) {
      return App.createPagedResults({ results: [] });
    }

    const page = (metadata as { page?: number } | undefined)?.page ?? 1;
    const results = this.cards(await this.fetch(this.listingUrl({ page, order: entry.order })));

    return App.createPagedResults({
      results,
      metadata: results.length < PAGE_SIZE ? undefined : { page: page + 1 },
    });
  }

  async getSearchResults(query: SearchRequest, metadata: unknown): Promise<PagedResults> {
    const page = (metadata as { page?: number } | undefined)?.page ?? 1;
    const title = (query.title ?? "").trim();
    const genre = (query.includedTags ?? [])[0]?.id;

    // A genre page cannot be searched by title, so when both are given the
    // genre picks the listing and the title filters what comes back.
    const html = genre
      ? await this.fetch(this.listingUrl({ page, genre }))
      : title
        ? await this.fetch(
            `${DOMAIN}/page/${page}/?s=${encodeURIComponent(title)}&post_type=wp-manga`,
          )
        : await this.fetch(this.listingUrl({ page }));

    const found = this.cards(html);
    const results =
      genre && title
        ? found.filter((row) => (row.title ?? "").toLowerCase().includes(title.toLowerCase()))
        : found;

    // Paging is decided by what the page held, not by what survived the filter,
    // so a page with no match still advances to the next one.
    return App.createPagedResults({
      results,
      metadata: found.length < PAGE_SIZE ? undefined : { page: page + 1 },
    });
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const html = await this.fetch(this.getMangaShareUrl(mangaId));
    const $ = this.cheerio.load(html);

    const title = this.decode(
      $("h1.htitle").first().text() || ($('meta[property="og:title"]').attr("content") ?? ""),
    );

    const desc = this.decode(
      (
        $("p.hsyn").first().text() ||
        ($('meta[property="og:description"]').attr("content") ?? "")
      ).replace(/^Read\s+(manhwa|manhua|manga)\s+/i, ""),
    );

    const genres: Tag[] = [];
    const seen = new Set<string>();

    for (const element of $("div.hchips--genres a.chip").toArray()) {
      const id = this.slugOf($(element).attr("href") ?? "");
      const label = this.decode($(element).text());

      if (id && label && !seen.has(id)) {
        seen.add(id);
        genres.push(App.createTag({ id, label }));
      }
    }

    const statusText = $("span.htag--status").first().text();
    const rating = Number(
      /[0-9.]+/.exec($("div.hinfo span.rt, div.htag span.rt").first().text())?.[0],
    );

    return App.createSourceManga({
      id: mangaId,
      mangaInfo: App.createMangaInfo({
        titles: [title || mangaId],
        image: this.absolute(
          $('meta[property="og:image"]').attr("content") ?? `${DOMAIN}/favicon.ico`,
        ),
        desc,
        status: /complet|finish/i.test(statusText) ? "Completed" : "Ongoing",
        ...(Number.isFinite(rating) && rating > 0 ? { rating } : {}),
        ...(genres.length > 0
          ? { tags: [App.createTagSection({ id: "genres", label: "Genres", tags: genres })] }
          : {}),
      }),
    });
  }

  // The series page's own chapter JSON is served stale and truncated; this
  // POST route is uncached and complete.
  async getChapters(mangaId: string): Promise<Chapter[]> {
    const $ = this.cheerio.load(
      await this.fetch(`${DOMAIN}/manga/${mangaId}/ajax/chapters/`, "POST"),
    );

    const rows: { id: string; chapNum: number; time?: Date }[] = [];
    const seen = new Set<string>();

    for (const element of $("li.wp-manga-chapter").toArray()) {
      const link = $(element).find("a").first();
      const id = this.slugOf(link.attr("href") ?? "");

      if (!id || seen.has(id)) {
        continue;
      }

      seen.add(id);
      rows.push({
        id,
        chapNum: Number(/([0-9]+(?:\.[0-9]+)?)/.exec(this.decode(link.text()))?.[1]) || 0,
        time: this.ago($(element).find("span.chapter-release-date").first().text()),
      });
    }

    if (rows.length === 0) {
      throw new Error(`No chapters were found for ${mangaId}.`);
    }

    rows.sort((left, right) => right.chapNum - left.chapNum);

    // Chapters are built once, with their order: spreading one back into a plain
    // object loses what the app needs on the other side of the bridge.
    return rows.map((row, index) =>
      App.createChapter({
        id: row.id,
        chapNum: row.chapNum,
        langCode: "en",
        sortingIndex: rows.length - index,
        ...(row.time ? { time: row.time } : {}),
      }),
    );
  }

  async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
    const $ = this.cheerio.load(await this.fetch(`${DOMAIN}/manga/${mangaId}/${chapterId}/`));
    const pages: string[] = [];

    for (const element of $("div.page-break img, img.wp-manga-chapter-img").toArray()) {
      const page = this.cover($(element));

      if (page && !page.endsWith("favicon.ico") && !pages.includes(page)) {
        pages.push(page);
      }
    }

    if (pages.length === 0) {
      throw new Error(`No pages were found for ${chapterId}.`);
    }

    return App.createChapterDetails({ id: chapterId, mangaId, pages });
  }
}

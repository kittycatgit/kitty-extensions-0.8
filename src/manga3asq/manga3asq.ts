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

const DOMAIN = "https://3asq.online";
const PAGE_SIZE = 21;

// Titles and orderings follow the site's own listing options.
const HOME_SECTIONS = [
  { id: "new_manga", title: "New Series", order: "new-manga" },
  { id: "latest", title: "Recently Updated", order: "latest" },
  { id: "trending", title: "Currently Trending", order: "trending" },
  { id: "views", title: "Most Popular", order: "views" },
] as const;

export const manga3asqInfo: SourceInfo = {
  version: "2.0.0",
  name: "manga3asq",
  icon: "icon.png",
  author: "kittycatgit",
  authorWebsite: "https://github.com/kittycatgit",
  description: "Extension that pulls content from 3asq.online.",
  contentRating: ContentRating.MATURE,
  websiteBaseURL: DOMAIN,
  language: "ar",
  intents:
    SourceIntents.MANGA_CHAPTERS |
    SourceIntents.HOMEPAGE_SECTIONS |
    SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
};

export class manga3asq
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
      headers: { "user-agent": await this.requestManager.getDefaultUserAgent() },
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

  // WordPress renders the Arabic locale's month names, which Date cannot read.
  // The class starts at 0621 because the Arabic comma sits in the lower block
  // and would otherwise be swallowed into the month name.
  private arabicDate(value: string): Date | undefined {
    const months: Record<string, number> = {
      "\u064A\u0646\u0627\u064A\u0631": 0,
      "\u0641\u0628\u0631\u0627\u064A\u0631": 1,
      "\u0645\u0627\u0631\u0633": 2,
      "\u0623\u0628\u0631\u064A\u0644": 3,
      "\u0625\u0628\u0631\u064A\u0644": 3,
      "\u0645\u0627\u064A\u0648": 4,
      "\u064A\u0648\u0646\u064A\u0648": 5,
      "\u064A\u0648\u0644\u064A\u0648": 6,
      "\u0623\u063A\u0633\u0637\u0633": 7,
      "\u0627\u063A\u0633\u0637\u0633": 7,
      "\u0633\u0628\u062A\u0645\u0628\u0631": 8,
      "\u0623\u0643\u062A\u0648\u0628\u0631": 9,
      "\u0627\u0643\u062A\u0648\u0628\u0631": 9,
      "\u0646\u0648\u0641\u0645\u0628\u0631": 10,
      "\u062F\u064A\u0633\u0645\u0628\u0631": 11,
    };

    const match = /(\d{1,2})\s*([\u0621-\u06FF]+)[\u060C,]?\s*(\d{4})/.exec(value);
    const month = match ? months[match[2] ?? ""] : undefined;

    if (!match || month === undefined) {
      return undefined;
    }

    return new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  }

  private slugOf(href: string): string {
    return (href ?? "").split("?")[0]?.replace(/\/$/, "").split("/").pop()?.trim() ?? "";
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

  private image(node: ReturnType<CheerioAPI>): string {
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

    return `${DOMAIN}/image/none.webp`;
  }

  // Listing titles carry a scanlator badge that links to the group's X account,
  // so the series is always the last anchor, never the first.
  private listing(html: string): PartialSourceManga[] {
    const $ = this.cheerio.load(html);
    const results: PartialSourceManga[] = [];
    const seen = new Set<string>();

    for (const element of $("div.page-item-detail").toArray()) {
      const link = $("a", $("h3.h5", element)).last();
      const slug = this.slugOf(link.attr("href") ?? "");
      const title = this.decode(link.text());

      // /manga/feed/ is WordPress' RSS route, not a series.
      if (!slug || slug === "feed" || !title || seen.has(slug)) {
        continue;
      }

      seen.add(slug);

      const chapter = this.decode($("span.font-meta.chapter", element).first().text());

      results.push(
        App.createPartialSourceManga({
          mangaId: slug,
          title,
          image: this.image($("img", element)),
          ...(chapter ? { subtitle: chapter } : {}),
        }),
      );
    }

    return results;
  }

  private searchRows(html: string): PartialSourceManga[] {
    const $ = this.cheerio.load(html);
    const results: PartialSourceManga[] = [];
    const seen = new Set<string>();

    for (const element of $("div.c-tabs-item__content").toArray()) {
      const link = $("a", element).first();
      const slug = this.slugOf(link.attr("href") ?? "");
      const title = this.decode(link.attr("title") ?? $("div.post-title", element).first().text());

      if (!slug || slug === "feed" || !title || seen.has(slug)) {
        continue;
      }

      seen.add(slug);

      const chapter = this.decode($("span.font-meta.chapter", element).first().text());

      results.push(
        App.createPartialSourceManga({
          mangaId: slug,
          title,
          image: this.image($("img", element)),
          ...(chapter ? { subtitle: chapter } : {}),
        }),
      );
    }

    return results;
  }

  // Page 1 redirects to the bare listing url, which iOS will not follow onto
  // plain http, so it is requested without the page segment.
  private listingUrl(page: number, order: string): string {
    return page <= 1
      ? `${DOMAIN}/manga/?m_orderby=${order}`
      : `${DOMAIN}/manga/page/${page}/?m_orderby=${order}`;
  }

  async getSearchTags(): Promise<TagSection[]> {
    const $ = this.cheerio.load(await this.fetch(`${DOMAIN}/?s=&post_type=wp-manga`));
    const tags: Tag[] = [];
    const seen = new Set<string>();

    for (const element of $("div.checkbox-group div.checkbox").toArray()) {
      const id = ($("input", element).attr("value") ?? "").trim();
      const label = this.decode($("label", element).text());

      if (id && label && !seen.has(id)) {
        seen.add(id);
        tags.push(App.createTag({ id, label }));
      }
    }

    return tags.length > 0 ? [App.createTagSection({ id: "genres", label: "Genres", tags })] : [];
  }

  async supportsTagExclusion(): Promise<boolean> {
    return false;
  }

  async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
    for (const [index, entry] of HOME_SECTIONS.entries()) {
      sectionCallback(
        App.createHomeSection({
          id: entry.id,
          title: entry.title,
          type: index === 0 ? HomeSectionType.singleRowLarge : HomeSectionType.singleRowNormal,
          containsMoreItems: true,
        }),
      );
    }

    const pages = await Promise.all(
      HOME_SECTIONS.map((entry) => this.fetch(this.listingUrl(1, entry.order)).catch(() => "")),
    );

    for (const [index, entry] of HOME_SECTIONS.entries()) {
      sectionCallback(
        App.createHomeSection({
          id: entry.id,
          title: entry.title,
          type: index === 0 ? HomeSectionType.singleRowLarge : HomeSectionType.singleRowNormal,
          containsMoreItems: true,
          items: this.listing(pages[index] ?? ""),
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
    const results = this.listing(await this.fetch(this.listingUrl(page, entry.order)));

    return App.createPagedResults({
      results,
      metadata: results.length < PAGE_SIZE ? undefined : { page: page + 1 },
    });
  }

  async getSearchResults(query: SearchRequest, metadata: unknown): Promise<PagedResults> {
    const page = (metadata as { page?: number } | undefined)?.page ?? 1;
    const title = (query.title ?? "").trim();
    const parts = [`s=${encodeURIComponent(title)}`, "post_type=wp-manga"];

    (query.includedTags ?? []).forEach((tag, index) => {
      parts.push(`genre%5B${index}%5D=${encodeURIComponent(tag.id ?? "")}`);
    });

    if ((query.includedTags ?? []).length > 0) {
      parts.push("op=1");
    }

    const url =
      page <= 1 ? `${DOMAIN}/?${parts.join("&")}` : `${DOMAIN}/page/${page}/?${parts.join("&")}`;
    const results = this.searchRows(await this.fetch(url));

    return App.createPagedResults({
      results,
      metadata: results.length === 0 ? undefined : { page: page + 1 },
    });
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const $ = this.cheerio.load(await this.fetch(this.getMangaShareUrl(mangaId)));

    const title = this.decode(
      $("div.post-title h1").first().children().remove().end().text() ||
        ($('meta[property="og:title"]').attr("content") ?? ""),
    );

    const desc = this.decode(
      $("div.description-summary div.summary__content, div.summary__content, div.manga-excerpt")
        .first()
        .text(),
    );

    const genres: Tag[] = [];
    const seen = new Set<string>();

    for (const element of $("div.genres-content a").toArray()) {
      const label = this.decode($(element).text());
      const id = this.slugOf($(element).attr("href") ?? "") || label.toLowerCase();

      if (id && label && !seen.has(id)) {
        seen.add(id);
        genres.push(App.createTag({ id, label }));
      }
    }

    const rows = new Map<string, string>();
    for (const element of $("div.post-content_item").toArray()) {
      const label = this.decode($("div.summary-heading", element).text()).toLowerCase();
      const value = this.decode($("div.summary-content", element).text());

      if (label) {
        rows.set(label, value);
      }
    }

    const status = [...rows.entries()].find(([key]) => /status|الحالة/i.test(key))?.[1] ?? "";
    const rating = Number($("#averagerate").first().text().trim());

    return App.createSourceManga({
      id: mangaId,
      mangaInfo: App.createMangaInfo({
        titles: [title || mangaId],
        image: this.image($("div.summary_image img")),
        desc,
        status: /completed|مكتمل/i.test(status) ? "Completed" : "Ongoing",
        ...(Number.isFinite(rating) && rating > 0 ? { rating } : {}),
        ...(genres.length > 0
          ? { tags: [App.createTagSection({ id: "genres", label: "Genres", tags: genres })] }
          : {}),
      }),
    });
  }

  // admin-ajax answers 400 here; this per-series route serves the whole list.
  async getChapters(mangaId: string): Promise<Chapter[]> {
    const $ = this.cheerio.load(
      await this.fetch(`${DOMAIN}/manga/${mangaId}/ajax/chapters/`, "POST"),
    );

    const rows: { id: string; chapNum: number; time?: Date }[] = [];
    const seen = new Set<string>();

    for (const element of $("li.wp-manga-chapter").toArray()) {
      const link = $("a", element).first();
      const id = this.slugOf(link.attr("href") ?? "");

      if (!id || seen.has(id)) {
        continue;
      }

      seen.add(id);

      const label = this.decode(link.text());
      const parsed = Number(/([0-9]+(?:\.[0-9]+)?)/.exec(label)?.[1] ?? id);
      // The span also carries a view count; the <i> holds just the date.
      const stamp = this.decode($("span.chapter-release-date i", element).first().text());
      const time = this.arabicDate(stamp);

      rows.push({
        id,
        chapNum: Number.isFinite(parsed) ? parsed : 0,
        ...(time && !isNaN(time.getTime()) ? { time } : {}),
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
        langCode: "ar",
        sortingIndex: rows.length - index,
        ...(row.time ? { time: row.time } : {}),
      }),
    );
  }

  async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
    const $ = this.cheerio.load(await this.fetch(`${DOMAIN}/manga/${mangaId}/${chapterId}/`));
    const pages: string[] = [];

    for (const element of $("div.page-break img, img.wp-manga-chapter-img").toArray()) {
      const page = this.image($(element));

      if (page && !page.endsWith("none.webp") && !pages.includes(page)) {
        pages.push(page);
      }
    }

    if (pages.length === 0) {
      throw new Error(`No pages were found for ${chapterId}.`);
    }

    return App.createChapterDetails({ id: chapterId, mangaId, pages });
  }
}

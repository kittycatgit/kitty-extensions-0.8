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

const DOMAIN = "https://rawkuma.net";
const API = `${DOMAIN}/wp-json/wp/v2`;
const PAGE_SIZE = 30;

const TAXONOMIES = [
  { id: "genre", label: "Genre", rest: "genre" },
  { id: "status", label: "Status", rest: "manga-status" },
  { id: "type", label: "Type", rest: "manga-type" },
] as const;

// The rendered catalogue ignores ?page= entirely, so browsing goes through the API.
const HOME_SECTIONS = [
  {
    id: "popular_today",
    title: "Popular Today",
    type: HomeSectionType.singleRowLarge,
    order: undefined,
  },
  {
    id: "latest_update",
    title: "Latest Update",
    type: HomeSectionType.singleRowNormal,
    order: "modified",
  },
  {
    id: "top_series",
    title: "Top Series",
    type: HomeSectionType.singleRowNormal,
    order: undefined,
  },
  { id: "new_series", title: "New Series", type: HomeSectionType.singleRowNormal, order: "date" },
] as const;

interface ApiManga {
  slug?: string;
  title?: { rendered?: string };
  _embedded?: { "wp:featuredmedia"?: { source_url?: string }[] };
}

interface Book {
  name?: string;
  alternateName?: string;
  description?: string;
  image?: { url?: string };
  author?: { name?: string };
  illustrator?: { name?: string };
  genre?: string[];
  creativeWorkStatus?: string;
  isCompleted?: boolean;
  aggregateRating?: { ratingValue?: number | string };
}

export const RawkumaInfo: SourceInfo = {
  version: "6.0.0",
  name: "Rawkuma",
  icon: "icon.png",
  author: "kittycatgit",
  authorWebsite: "https://github.com/kittycatgit",
  description: "Extension that pulls content from rawkuma.net.",
  contentRating: ContentRating.MATURE,
  websiteBaseURL: DOMAIN,
  language: "ja",
  intents:
    SourceIntents.MANGA_CHAPTERS |
    SourceIntents.HOMEPAGE_SECTIONS |
    SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
};

export class Rawkuma
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
      headers: {
        referer: `${DOMAIN}/`,
        "user-agent": await this.requestManager.getDefaultUserAgent(),
      },
    });
  }

  getMangaShareUrl(mangaId: string): string {
    return `${DOMAIN}/manga/${mangaId}/`;
  }

  private async fetch(url: string): Promise<string> {
    const response = await this.requestManager.schedule(
      App.createRequest({ url, method: "GET" }),
      1,
    );

    return typeof response.data === "string" ? response.data : String(response.data ?? "");
  }

  // Cards elsewhere serve a 96px crop; the original is the same name without it.
  private fullSize(url: string): string {
    return url.replace(/-\d+x\d+(\.[a-z]{3,4})$/i, "$1");
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

  private ago(text: string): Date | undefined {
    const match = /(\d+)\s*(second|minute|hour|day|week|month|year)/i.exec(text);

    if (!match) {
      return undefined;
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

  private catalogueUrl(options: {
    page: number;
    orderBy?: string;
    search?: string;
    tags?: Tag[];
  }): string {
    const parts = [`per_page=${PAGE_SIZE}`, `page=${options.page}`, "_embed=wp:featuredmedia"];

    if (options.orderBy) {
      parts.push(`orderby=${options.orderBy}`, "order=desc");
    }

    if (options.search) {
      parts.push(`search=${encodeURIComponent(options.search)}`);
    }

    // Tag ids are "<taxonomy>:<term id>", which is how they survive the round trip.
    const byTaxonomy = new Map<string, string[]>();

    for (const tag of options.tags ?? []) {
      const [group, term] = (tag.id ?? "").split(":");
      const taxonomy = TAXONOMIES.find((entry) => entry.id === group);

      if (taxonomy && term) {
        byTaxonomy.set(taxonomy.rest, [...(byTaxonomy.get(taxonomy.rest) ?? []), term]);
      }
    }

    for (const [rest, terms] of byTaxonomy) {
      parts.push(`${rest}=${terms.join(",")}`);
    }

    return `${API}/manga?${parts.join("&")}`;
  }

  async getSearchTags(): Promise<TagSection[]> {
    const sections: TagSection[] = [];

    for (const taxonomy of TAXONOMIES) {
      const terms = JSON.parse(
        await this.fetch(`${API}/${taxonomy.rest}?per_page=100&orderby=name&order=asc`),
      ) as { id?: number; name?: string; slug?: string }[];

      const tags = terms
        .filter((term) => term.id !== undefined && term.name)
        .map((term) =>
          App.createTag({ id: `${taxonomy.id}:${term.id}`, label: this.decode(term.name ?? "") }),
        );

      if (tags.length > 0) {
        sections.push(App.createTagSection({ id: taxonomy.id, label: taxonomy.label, tags }));
      }
    }

    return sections;
  }

  async supportsTagExclusion(): Promise<boolean> {
    return false;
  }

  private async catalogue(url: string): Promise<PagedResults> {
    const rows = JSON.parse(await this.fetch(url)) as ApiManga[];
    const results: PartialSourceManga[] = [];

    for (const row of rows) {
      const slug = (row.slug ?? "").trim();

      // /manga/feed/ is WordPress' RSS endpoint, not a title.
      if (!slug || slug === "feed") {
        continue;
      }

      results.push(
        App.createPartialSourceManga({
          mangaId: slug,
          title: this.decode(row.title?.rendered ?? slug),
          image: this.fullSize(
            row._embedded?.["wp:featuredmedia"]?.[0]?.source_url ?? `${DOMAIN}/favicon.ico`,
          ),
        }),
      );
    }

    return App.createPagedResults({ results });
  }

  private sectionTiles(html: string, title: string, next?: string): PartialSourceManga[] {
    const start = html.indexOf(title);

    if (start < 0) {
      return [];
    }

    const end = next ? html.indexOf(next, start + title.length) : -1;
    const $ = this.cheerio.load(html.slice(start, end > 0 ? end : undefined));
    const tiles: PartialSourceManga[] = [];
    const seen = new Set<string>();

    for (const element of $('a[href*="/manga/"]').toArray()) {
      const href = ($(element).attr("href") ?? "").trim();
      const slug = /\/manga\/([a-z0-9-]+)\/?$/.exec(href)?.[1] ?? "";
      const image = $(element).find("img").first();
      const name = (image.attr("alt") ?? "").trim();

      if (!slug || slug === "feed" || !name || seen.has(slug)) {
        continue;
      }

      seen.add(slug);
      tiles.push(
        App.createPartialSourceManga({
          mangaId: slug,
          title: this.decode(name),
          image: this.fullSize((image.attr("src") ?? "").trim()) || `${DOMAIN}/favicon.ico`,
        }),
      );
    }

    return tiles;
  }

  async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
    for (const entry of HOME_SECTIONS) {
      sectionCallback(
        App.createHomeSection({
          id: entry.id,
          title: entry.title,
          type: entry.type,
          containsMoreItems: entry.order !== undefined,
        }),
      );
    }

    const html = await this.fetch(`${DOMAIN}/`);

    for (const [index, entry] of HOME_SECTIONS.entries()) {
      sectionCallback(
        App.createHomeSection({
          id: entry.id,
          title: entry.title,
          type: entry.type,
          containsMoreItems: entry.order !== undefined,
          items: this.sectionTiles(html, entry.title, HOME_SECTIONS[index + 1]?.title),
        }),
      );
    }
  }

  async getViewMoreItems(homepageSectionId: string, metadata: unknown): Promise<PagedResults> {
    const entry = HOME_SECTIONS.find((row) => row.id === homepageSectionId);

    // The API can order by date and modification, but has no notion of popularity.
    if (!entry?.order) {
      return App.createPagedResults({ results: [] });
    }

    const page = (metadata as { page?: number } | undefined)?.page ?? 1;
    const results = await this.catalogue(this.catalogueUrl({ page, orderBy: entry.order }));

    return App.createPagedResults({
      results: results.results,
      metadata: (results.results?.length ?? 0) < PAGE_SIZE ? undefined : { page: page + 1 },
    });
  }

  async getSearchResults(query: SearchRequest, metadata: unknown): Promise<PagedResults> {
    const page = (metadata as { page?: number } | undefined)?.page ?? 1;
    const results = await this.catalogue(
      this.catalogueUrl({
        page,
        search: (query.title ?? "").trim() || undefined,
        tags: query.includedTags,
      }),
    );

    return App.createPagedResults({
      results: results.results,
      metadata: (results.results?.length ?? 0) < PAGE_SIZE ? undefined : { page: page + 1 },
    });
  }

  private book(html: string): Book {
    for (const match of html.matchAll(
      /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi,
    )) {
      try {
        const parsed = JSON.parse(match[1] ?? "") as Record<string, unknown>;
        const type = parsed["@type"];

        if (type === "Book" || (Array.isArray(type) && type.includes("Book"))) {
          return parsed as Book;
        }
      } catch {
        continue;
      }
    }

    return {};
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const book = this.book(await this.fetch(this.getMangaShareUrl(mangaId)));
    const genres = (book.genre ?? []).map((name) =>
      App.createTag({ id: name.toLowerCase(), label: name }),
    );

    return App.createSourceManga({
      id: mangaId,
      mangaInfo: App.createMangaInfo({
        titles: [
          this.decode(book.name ?? mangaId),
          ...(book.alternateName ? [this.decode(book.alternateName)] : []),
        ],
        image: this.fullSize(book.image?.url ?? `${DOMAIN}/favicon.ico`),
        desc: this.decode(book.description ?? ""),
        status: book.creativeWorkStatus ?? (book.isCompleted ? "Completed" : "Ongoing"),
        ...(book.author?.name ? { author: book.author.name } : {}),
        ...(book.illustrator?.name ? { artist: book.illustrator.name } : {}),
        ...(book.aggregateRating?.ratingValue
          ? { rating: Number(book.aggregateRating.ratingValue) }
          : {}),
        ...(genres.length > 0
          ? { tags: [App.createTagSection({ id: "genres", label: "Genres", tags: genres })] }
          : {}),
      }),
    });
  }

  async getChapters(mangaId: string): Promise<Chapter[]> {
    const $ = this.cheerio.load(await this.fetch(this.getMangaShareUrl(mangaId)));
    const rows: { id: string; chapNum: number; time?: Date }[] = [];
    const seen = new Set<string>();

    for (const element of $('a[href*="/chapter-"]').toArray()) {
      // The theme writes these hrefs with a leading space inside the attribute.
      const href = ($(element).attr("href") ?? "").trim();
      const id = /\/manga\/[a-z0-9-]+\/(chapter-[\d.]+)\/?$/.exec(href)?.[1] ?? "";

      if (!id || seen.has(id)) {
        continue;
      }

      seen.add(id);
      // id is chapter-{num}.{postId}, so the post id is after the last dot.
      rows.push({
        id,
        chapNum: Number(id.replace(/^chapter-/, "").replace(/\.[^.]*$/, "")) || 0,
        // The label and the date collapse into one string ("Chapter 1766 days
        // ago"), so the date is read from its own element.
        time: this.ago($(element).find("time").first().text()),
      });
    }

    rows.sort((left, right) => right.chapNum - left.chapNum);

    // Chapters are built once, with their order: spreading one back into a plain
    // object loses what the app needs on the other side of the bridge.
    return rows.map((row, index) =>
      App.createChapter({
        id: row.id,
        chapNum: row.chapNum,
        langCode: "ja",
        sortingIndex: rows.length - index,
        ...(row.time ? { time: row.time } : {}),
      }),
    );
  }

  async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
    // The chapter id ends in the site's own post id, which its API answers with.
    const postId =
      chapterId
        .replace(/^chapter-/, "")
        .split(".")
        .pop() ?? "";
    const chapter = JSON.parse(await this.fetch(`${API}/chapter/${postId}`)) as {
      content?: { rendered?: string };
    };

    const $ = this.cheerio.load(chapter.content?.rendered ?? "");
    const pages = $("img")
      .toArray()
      .map((element) => ($(element).attr("src") ?? "").trim())
      .filter((src) => src.length > 0);

    if (pages.length === 0) {
      throw new Error(`No pages were found for ${chapterId}.`);
    }

    return App.createChapterDetails({ id: chapterId, mangaId, pages });
  }
}

/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 kittycatgit */

import { Chapter, ContentRating, SourceManga, Tag } from "@paperback/types";

import {
  CONTENT_RATINGS,
  DOMAIN,
  FALLBACK_COVER,
  GENRES,
  STATUS_LABELS,
  type ApiChapter,
  type ApiPage,
  type ApiSeries,
} from "./models";

// The detail route returns a JSON-encoded array while search hits return a real
// array, and either can hold objects rather than strings.
export function normaliseTitles(raw: ApiSeries["alternativeTitles"]): string[] {
  let values: unknown = raw;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") {
      return [];
    }

    try {
      values = JSON.parse(trimmed);
    } catch {
      return [trimmed];
    }
  }

  if (!Array.isArray(values)) {
    return [];
  }

  const titles: string[] = [];

  for (const value of values) {
    const title =
      typeof value === "string"
        ? value
        : typeof (value as { name?: unknown })?.name === "string"
          ? (value as { name: string }).name
          : undefined;

    const cleaned = title?.trim();
    if (cleaned && !titles.includes(cleaned)) {
      titles.push(cleaned);
    }
  }

  return titles;
}

export function contentRatingOf(raw: string | null | undefined): ContentRating {
  return CONTENT_RATINGS[(raw ?? "").toLowerCase()] ?? ContentRating.ADULT;
}

function statusOf(raw: string | null | undefined): string {
  const key = (raw ?? "").toLowerCase();
  return STATUS_LABELS[key] ?? (key ? key.charAt(0).toUpperCase() + key.slice(1) : "Unknown");
}

function joinNames(values: string[] | null | undefined): string | undefined {
  const names = (values ?? []).map((value) => value.trim()).filter(Boolean);
  return names.length > 0 ? names.join(", ") : undefined;
}

export function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const GENRE_SLUGS = new Map(GENRES.map((genre) => [genre.label.toLowerCase(), genre.id]));

// The detail route names genres rather than slugging them, and an id may not
// hold spaces - a name like "Age Gap" is rejected and takes the title with it.
export function genreId(name: string): string {
  const known = GENRE_SLUGS.get(name.toLowerCase());

  if (known) {
    return known;
  }

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._\-@()[\]%?#+=/&:]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");

  return slug || "unknown";
}

export function parseMangaDetails(series: ApiSeries, chapterCount?: number): SourceManga {
  const genres = (series.genres ?? []).filter((genre) => typeof genre === "string" && genre.trim());
  const tags: Tag[] = genres.map((genre) => App.createTag({ id: genreId(genre), label: genre }));

  const additionalInfo: Record<string, string> = {};
  if (series.type) {
    additionalInfo["Type"] = capitalise(series.type);
  }
  if (typeof series.year === "number") {
    additionalInfo["Year"] = String(series.year);
  }
  if (typeof series.views === "number") {
    additionalInfo["Views"] = series.views.toLocaleString("en-US");
  }
  if (typeof series.favorites === "number") {
    additionalInfo["Favorites"] = series.favorites.toLocaleString("en-US");
  }
  if (typeof series.score === "number") {
    const scoredBy = typeof series.scoredBy === "number" ? ` (${series.scoredBy} votes)` : "";
    additionalInfo["Rating"] = `${series.score.toFixed(1)} / 5${scoredBy}`;
  }
  if (typeof chapterCount === "number") {
    additionalInfo["Chapters"] = String(chapterCount);
  }

  const author = joinNames(series.authors);
  const artist = joinNames(series.artists);
  const rating = series.score;

  return App.createSourceManga({
    id: series.slug,
    mangaInfo: App.createMangaInfo({
      titles: [series.title?.trim() || series.slug, ...normaliseTitles(series.alternativeTitles)],
      image: series.coverUrl || FALLBACK_COVER,
      desc: (series.synopsis ?? "").trim(),
      status: statusOf(series.status),
      hentai: contentRatingOf(series.contentRating) === ContentRating.ADULT,
      ...(author ? { author } : {}),
      ...(artist ? { artist } : {}),
      ...(typeof rating === "number" && Number.isFinite(rating) ? { rating } : {}),
      ...(tags.length > 0
        ? { tags: [App.createTagSection({ id: "genres", label: "Genres", tags })] }
        : {}),
      ...(Object.keys(additionalInfo).length > 0 ? { additionalInfo } : {}),
    }),
  });
}

export function shareUrl(mangaId: string): string {
  return `${DOMAIN}/manga/${mangaId}`;
}

export function parseChapters(rows: ApiChapter[]): Chapter[] {
  const sorted = [...rows].sort((a, b) => b.number - a.number);

  return sorted.map((row, index) => {
    const published = row.createdAt ? new Date(row.createdAt) : undefined;
    const title = row.title?.trim();

    return App.createChapter({
      // The reader is addressed by chapter number, not by a slug.
      id: String(row.number),
      chapNum: row.number,
      langCode: (row.language ?? "en").toLowerCase(),
      sortingIndex: sorted.length - index,
      ...(title ? { name: title } : {}),
      ...(typeof row.volume === "number" ? { volume: row.volume } : {}),
      ...(published && !Number.isNaN(published.getTime()) ? { time: published } : {}),
    });
  });
}

export function parseChapterPages(pages: ApiPage[]): string[] {
  return [...pages]
    .sort((a, b) => a.pageOrder - b.pageOrder)
    .map((page) => page.webpUrl ?? page.avifUrl ?? "")
    .filter((url) => url.length > 0);
}

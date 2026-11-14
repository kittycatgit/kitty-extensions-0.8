/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 kittycatgit */

import { Chapter, SourceManga, Tag } from "@paperback/types";

import {
  COVER_CDN,
  DOMAIN,
  FALLBACK_COVER,
  GENRES,
  PAGE_CDN,
  STATUS_LABELS,
  type ApiChapter,
  type ApiChapterFull,
  type ApiManga,
} from "./models";

const GENRE_SLUGS = new Map(GENRES.map((genre) => [genre.label.toLowerCase(), genre.id]));

// Ids allow only alphanumerics and `._-@()[]%?#+=/&:`, so a name like "Martial
// Arts" fails the whole title. The catalogue slug also matches the search filter.
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

// Covers arrive as a bare path such as `mh/eleceed.jpg`, and some titles have
// none - an empty string is not a URL the app accepts.
export function coverUrl(image: string | null | undefined): string {
  const path = (image ?? "").trim();

  if (!path) {
    return FALLBACK_COVER;
  }

  return /^https?:\/\//i.test(path) ? path : `${COVER_CDN}/${path.replace(/^\/+/, "")}`;
}

export function isAdult(manga: ApiManga): boolean {
  // Listing rows only carry `isSafe`, so anything unflagged counts as mature.
  return Boolean(manga.isPorn || manga.isSoftPorn || manga.isYaoi);
}

function statusOf(raw: string | null | undefined): string {
  const key = (raw ?? "").toLowerCase();
  return STATUS_LABELS[key] ?? (key ? key.charAt(0).toUpperCase() + key.slice(1) : "Unknown");
}

// `genres` is a comma-separated string, not a list.
export function splitGenres(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

// `alternativeTitle` is a semicolon-separated string.
export function splitAlternativeTitles(raw: string | null | undefined): string[] {
  const titles: string[] = [];

  for (const part of (raw ?? "").split(";")) {
    const cleaned = typeof part === "string" ? part.trim() : "";

    if (cleaned && !titles.includes(cleaned)) {
      titles.push(cleaned);
    }
  }

  return titles;
}

export function shareUrl(mangaId: string): string {
  return `${DOMAIN}/manga/${mangaId}`;
}

export function parseMangaDetails(manga: ApiManga): SourceManga {
  const genres = splitGenres(manga.genres);
  const tags: Tag[] = genres.map((genre) => App.createTag({ id: genreId(genre), label: genre }));
  const chapterCount = manga.chapters?.length;

  const additionalInfo: Record<string, string> = {};
  if (typeof manga.latestChapter === "number") {
    additionalInfo["Latest Chapter"] = String(manga.latestChapter);
  }
  if (typeof chapterCount === "number") {
    additionalInfo["Chapters"] = String(chapterCount);
  }
  if (typeof manga.rank === "number") {
    additionalInfo["Rank"] = `#${manga.rank}`;
  }
  if (manga.isWebtoon) {
    additionalInfo["Format"] = "Webtoon";
  }
  if (manga.isLicensed) {
    additionalInfo["Licensed"] = "Yes";
  }
  if (manga.updatedDate) {
    const updated = new Date(manga.updatedDate);

    if (!Number.isNaN(updated.getTime())) {
      additionalInfo["Updated"] = updated.toISOString().slice(0, 10);
    }
  }

  const author = manga.author?.trim();
  const artist = manga.artist?.trim();

  return App.createSourceManga({
    id: manga.slug,
    mangaInfo: App.createMangaInfo({
      titles: [
        manga.title?.trim() || manga.slug,
        ...splitAlternativeTitles(manga.alternativeTitle),
      ],
      image: coverUrl(manga.image),
      desc: (manga.description ?? "").trim(),
      status: statusOf(manga.status),
      hentai: isAdult(manga),
      ...(author ? { author } : {}),
      ...(artist ? { artist } : {}),
      ...(tags.length > 0
        ? { tags: [App.createTagSection({ id: "genres", label: "Genres", tags })] }
        : {}),
      ...(Object.keys(additionalInfo).length > 0 ? { additionalInfo } : {}),
    }),
  });
}

// The API lists chapters oldest first; the app wants newest first.
export function parseChapters(rows: ApiChapter[]): Chapter[] {
  const sorted = [...rows].sort((a, b) => b.number - a.number);

  return sorted.map((row, index) => {
    const published = row.date ? new Date(row.date) : undefined;
    const title = row.title?.trim();

    return App.createChapter({
      // The reader endpoint is addressed by chapter number, not by any row id.
      id: String(row.number),
      chapNum: row.number,
      langCode: "en",
      sortingIndex: sorted.length - index,
      ...(title ? { name: title } : {}),
      ...(published && !Number.isNaN(published.getTime()) ? { time: published } : {}),
    });
  });
}

// `pages` is a JSON string, not an object: `p` is a shared path prefix and `i`
// the file name of each page.
export function parseChapterPages(chapter: ApiChapterFull): string[] {
  const raw = chapter.pages;

  if (!raw) {
    return [];
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const { p, i } = payload as { p?: unknown; i?: unknown };
  const prefix = typeof p === "string" ? p : "";

  if (!Array.isArray(i)) {
    return [];
  }

  return i
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .map((name) => `${PAGE_CDN}/${`${prefix}${name}`.replace(/^\/+/, "")}`);
}

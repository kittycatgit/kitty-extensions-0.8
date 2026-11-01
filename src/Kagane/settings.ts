/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 kittycatgit */

import { DUIFormRow, DUISection } from "@paperback/types";

import { KaganeApi } from "./api";
import {
  AGE_RATINGS,
  CONTENT_LANGUAGES_KEY,
  CONTENT_RATINGS_KEY,
  CUSTOM_HIDDEN_TAGS_KEY,
  EXCLUDED_GENRES_KEY,
  HIDDEN_TAG_CATEGORIES_KEY,
  LANGUAGES,
  MIRRORS_URL,
  SHOW_DISTURBING_KEY,
  SHOW_PORNOGRAPHIC_KEY,
  SHOW_SOURCE_KEY,
  SOURCE_DISPLAY_MODES,
  SOURCE_DISPLAY_MODE_KEY,
  TAG_MATCH_ALL_KEY,
} from "./models";
import {
  getContentLanguages,
  getContentRatings,
  getCustomHiddenTags,
  getDomainOverride,
  getExcludedGenres,
  getShowDisturbing,
  getShowPornographic,
  getShowSource,
  getSourceDisplayMode,
  getTagMatchAll,
  setDomainOverride,
  stateManager,
} from "./state";
import { HIDDEN_TAG_CATEGORIES } from "./tags";

function select(info: {
  id: string;
  label: string;
  options: string[];
  labels: Record<string, string>;
  read: () => Promise<string[]>;
  key: string;
  multi: boolean;
}): DUIFormRow {
  return App.createDUISelect({
    id: info.id,
    label: info.label,
    options: info.options,
    allowsMultiselect: info.multi,
    labelResolver: async (option) => info.labels[option] ?? option,
    value: App.createDUIBinding({
      get: info.read,
      set: async (value) => {
        await stateManager().store(info.key, Array.isArray(value) ? value : [value]);
      },
    }),
  });
}

function switchRow(
  id: string,
  label: string,
  key: string,
  read: () => Promise<boolean>,
): DUIFormRow {
  return App.createDUISwitch({
    id,
    label,
    value: App.createDUIBinding({
      get: read,
      set: async (value) => stateManager().store(key, Boolean(value)),
    }),
  });
}

export function buildSettings(api: KaganeApi): DUISection {
  return App.createDUISection({
    id: "kagane-settings",
    isHidden: false,
    rows: async () => [
      App.createDUINavigationButton({
        id: "kagane-settings-button",
        label: "Kagane Settings",
        form: App.createDUIForm({
          sections: async () => {
            const ratingLabels = Object.fromEntries(AGE_RATINGS.map((r) => [r.id, r.title]));
            const languageLabels = Object.fromEntries(LANGUAGES.map((l) => [l.id, l.title]));
            const modeLabels = Object.fromEntries(SOURCE_DISPLAY_MODES.map((m) => [m.id, m.title]));
            const categoryLabels = Object.fromEntries(
              HIDDEN_TAG_CATEGORIES.map((c) => [c.id, c.title]),
            );
            const currentDomain = await api.displayDomain();

            // Read live so the list matches the server and the stored ids are
            // the UUIDs the search body wants.
            let genreIds: string[] = [];
            let genreLabels: Record<string, string> = {};
            try {
              const genres = [...(await api.getTaxonomy()).genres].sort((left, right) =>
                left.genre_name.localeCompare(right.genre_name),
              );
              genreIds = genres.map((genre) => genre.id);
              genreLabels = Object.fromEntries(genres.map((g) => [g.id, g.genre_name]));
            } catch {
              genreIds = [];
            }

            return [
              App.createDUISection({
                id: "domain",
                header: "Domain",
                footer: `Kagane moves between domains. The live one is read from ${MIRRORS_URL} and kept for a day; set an override to use a domain as typed instead.`,
                isHidden: false,
                rows: async () => [
                  App.createDUILabel({
                    id: "current-domain",
                    label: "Current Domain",
                    value: currentDomain,
                  }),
                  App.createDUIInputField({
                    id: "domain-override",
                    label: "Override",
                    value: App.createDUIBinding({
                      get: getDomainOverride,
                      set: async (value) => {
                        await setDomainOverride(value);
                        await api.forgetDomain();
                      },
                    }),
                  }),
                  App.createDUIButton({
                    id: "recheck-mirrors",
                    label: "Re-check Mirrors",
                    onTap: async () => {
                      await api.forgetDomain();
                      await api.resolveDomain();
                    },
                  }),
                ],
              }),
              App.createDUISection({
                id: "content",
                header: "Content",
                footer:
                  "Titles outside the selected ratings and languages are hidden everywhere. Explicit and disturbing titles only show with 18+ selected.",
                isHidden: false,
                rows: async () => [
                  select({
                    id: "content-ratings",
                    label: "Age Ratings",
                    options: AGE_RATINGS.map((rating) => rating.id),
                    labels: ratingLabels,
                    read: getContentRatings,
                    key: CONTENT_RATINGS_KEY,
                    multi: true,
                  }),
                  switchRow(
                    "show-pornographic",
                    "Show Explicit Titles",
                    SHOW_PORNOGRAPHIC_KEY,
                    getShowPornographic,
                  ),
                  switchRow(
                    "show-disturbing",
                    "Show Disturbing Titles",
                    SHOW_DISTURBING_KEY,
                    getShowDisturbing,
                  ),
                  select({
                    id: "content-languages",
                    label: "Languages",
                    options: LANGUAGES.map((language) => language.id),
                    labels: languageLabels,
                    read: getContentLanguages,
                    key: CONTENT_LANGUAGES_KEY,
                    multi: true,
                  }),
                ],
              }),
              App.createDUISection({
                id: "sources",
                header: "Sources",
                isHidden: false,
                rows: async () => [
                  select({
                    id: "source-display-mode",
                    label: "Show",
                    options: SOURCE_DISPLAY_MODES.map((mode) => mode.id),
                    labels: modeLabels,
                    read: async () => [await getSourceDisplayMode()],
                    key: SOURCE_DISPLAY_MODE_KEY,
                    multi: false,
                  }),
                  switchRow("show-source", "Show Source In Title", SHOW_SOURCE_KEY, getShowSource),
                ],
              }),
              App.createDUISection({
                id: "genres",
                header: "Excluded Genres",
                footer:
                  genreIds.length > 0
                    ? "Titles carrying any of these are hidden from search and the home page."
                    : "Genres could not be loaded. Open settings again once the site is reachable.",
                isHidden: false,
                rows: async () =>
                  genreIds.length === 0
                    ? []
                    : [
                        select({
                          id: "excluded-genres",
                          label: "Excluded Genres",
                          options: genreIds,
                          labels: genreLabels,
                          read: getExcludedGenres,
                          key: EXCLUDED_GENRES_KEY,
                          multi: true,
                        }),
                      ],
              }),
              App.createDUISection({
                id: "tags",
                header: "Hidden Tags",
                footer:
                  "A category hides every variant tag it covers. Custom names are matched against the site's tag list.",
                isHidden: false,
                rows: async () => [
                  select({
                    id: "hidden-tag-categories",
                    label: "Hidden Tags",
                    options: HIDDEN_TAG_CATEGORIES.map((category) => category.id),
                    labels: categoryLabels,
                    read: async () => {
                      const stored = (await stateManager().retrieve(
                        HIDDEN_TAG_CATEGORIES_KEY,
                      )) as unknown;
                      return Array.isArray(stored) ? (stored as string[]) : [];
                    },
                    key: HIDDEN_TAG_CATEGORIES_KEY,
                    multi: true,
                  }),
                  App.createDUIInputField({
                    id: "custom-hidden-tags",
                    label: "Custom Hidden Tags",
                    value: App.createDUIBinding({
                      get: async () => (await getCustomHiddenTags()).join(", "),
                      set: async (value) => {
                        const names = String(value ?? "")
                          .split(",")
                          .map((entry) => entry.trim())
                          .filter((entry) => entry.length > 0);
                        await stateManager().store(CUSTOM_HIDDEN_TAGS_KEY, names);
                      },
                    }),
                  }),
                  switchRow(
                    "tag-match-all",
                    "Match All Selected Tags",
                    TAG_MATCH_ALL_KEY,
                    getTagMatchAll,
                  ),
                ],
              }),
            ];
          },
        }),
      }),
    ],
  });
}

/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 kittycatgit */

import { DUISection } from "@paperback/types";

import { ADULT_MODES, ADULT_MODE_KEY, LANGUAGE_OPTIONS, TAG_MATCH_ALL_KEY } from "./models";
import {
  getAdultMode,
  getLanguageSetting,
  getTagMatchAll,
  setLanguageSetting,
  stateManager,
} from "./state";

export function buildSettings(): DUISection {
  return App.createDUISection({
    id: "mangaball-settings",
    isHidden: false,
    rows: async () => [
      App.createDUINavigationButton({
        id: "mangaball-settings-button",
        label: "Mangaball Settings",
        form: App.createDUIForm({
          sections: async () => [
            App.createDUISection({
              id: "content",
              header: "Content",
              footer:
                "Applies to the home page rows and is the default for searches, the same switch the site itself carries.",
              isHidden: false,
              rows: async () => [
                App.createDUISelect({
                  id: "adult-mode",
                  label: "Content Rating",
                  options: ADULT_MODES.map((mode) => mode.id),
                  allowsMultiselect: false,
                  labelResolver: async (option) =>
                    ADULT_MODES.find((mode) => mode.id === option)?.title ?? option,
                  value: App.createDUIBinding({
                    get: async () => [await getAdultMode()],
                    set: async (value) => {
                      await stateManager().store(
                        ADULT_MODE_KEY,
                        Array.isArray(value) ? value : [value],
                      );
                    },
                  }),
                }),
              ],
            }),
            App.createDUISection({
              id: "language",
              header: "Chapter Language",
              footer: "Only chapters in the selected language(s) are listed.",
              isHidden: false,
              rows: async () => [
                App.createDUISelect({
                  id: "language-filter",
                  label: "Languages",
                  options: LANGUAGE_OPTIONS.map((option) => option.id),
                  allowsMultiselect: true,
                  labelResolver: async (option) =>
                    LANGUAGE_OPTIONS.find((entry) => entry.id === option)?.title ?? option,
                  value: App.createDUIBinding({
                    get: getLanguageSetting,
                    set: setLanguageSetting,
                  }),
                }),
              ],
            }),
            App.createDUISection({
              id: "filters",
              header: "Filters",
              footer:
                "Off: a title needs only one of the tags picked in the filter sheet instead of every one of them.",
              isHidden: false,
              rows: async () => [
                App.createDUISwitch({
                  id: "tag-match-all",
                  label: "Match All Selected Tags",
                  value: App.createDUIBinding({
                    get: getTagMatchAll,
                    set: async (value) => stateManager().store(TAG_MATCH_ALL_KEY, Boolean(value)),
                  }),
                }),
              ],
            }),
          ],
        }),
      }),
    ],
  });
}

# Design system — derived from the Canton Zürich sources

This application uses the **Canton Zürich** design language (not the City of
Zürich, not the University). Everything below was read from the official sources
on 2026-10-18 and translated into `public/styles/*.css`. Values are copied 1:1;
naming is ours (`--zh-*`) so we do not redistribute upstream SCSS.

## Sources actually read

| Source | Used for |
| --- | --- |
| <https://www.zh.ch/de/webangebote-entwickeln-und-gestalten.html> (and its `…/inhalt/designsystem.html` + `…/designsystem/community/ressourcen.html` pages) | scope of the design system, accessibility requirements (WCAG 2.2 AA, eCH-0059), pointer to the frontend repository |
| <https://github.com/Kanton-Zurich/frontend-designsystem> (Apache-2.0, `master`) | tokens and component behaviour: `src/assets/css/globals/_variables.scss`, `_fonts.scss`, `_grid.scss`, `src/atoms/button/button.scss`, `src/atoms/headings/headings.scss`, `src/atoms/tag/tag.scss`, `src/atoms/loading_circle/loading_circle.scss`, `src/atoms/form_input/form_input.scss`, `src/modules/back2top/back2top.scss`, `src/assets/fonts/Inter-{Regular,Black}.woff2` |
| <https://www.zh.ch/de/politik-staat/kanton/kantonale-verwaltung/corporatedesign.html> | corporate-design context: the cantonal colours/typography are the reference; the coat of arms and logo are protected marks we do **not** use |

## Tokens (`public/styles/zh-tokens.css`)

| Upstream token | Value | Ours |
| --- | --- | --- |
| `$colorBlue` | `#0070b4` | `--zh-blue` |
| `$colorDarkBlue` | `#00407c` | `--zh-darkblue` |
| `$colorTurqoise` | `#00797b` | `--zh-turquoise` |
| `$colorCyan` | `#009ee0` | `--zh-cyan` (spinner) |
| `$colorBordeaux` / `$colorMagenta` / `$colorViolet` / `$colorGreen` / `$colorRed` | `#b01657` / `#d40053` / `#7f3da7` / `#1a7f1f` / `#e2001a` | `--zh-bordeaux`, `--zh-magenta`, `--zh-violet`, `--zh-green`, `--zh-red` |
| `$colorBlack*` scale | `#000`, `#333`, `#666`, `#949494`, `#ccc`, `#d9d9d9`, `#f0f0f0`, `#f7f7f7` | `--zh-black`, `-80`, `-60`, `-40`, `-20`, `-15`, `-10`, `-5` |
| `$colorBg` / `$colorText` | `#f7f7f7` / `#000` | `--zh-color-bg`, `--zh-color-text` |
| soft colour variations (`$colorBlueSoft`, …) | `#edf5fa`, `#e0e8ee`, `#e8f3f2`, `#ece2f1`, `#ebf6eb`, `#f6e3ea` | `--zh-*-soft` |
| `$sizeFontRegular` base + `$sizeFont*` scale | 16 px base, 10/12/14/16/18/20/24/28/32/40/48/56/72 px | `--zh-font-*` |
| `$sizeFontHuge` curves (`$fontSizeCurves`) | h1 32→40→48 px across breakpoints | `.zh-heading--1` media queries |
| `$normalButtonSize` (`$sizeBiggerBig + $sizeTiny`) | 48 px | `--zh-control-height` (buttons, header search) |
| `$sizeBig` | 32 px | `--zh-control-height-small`, 32 px stage of controls |
| `form_input.scss` scales | 72 / 60 / 48 px | header search 48 px, sidebar 32 px (documented app step) |
| `$sizeMini … $sizeGiant` | 4/8/12/16/20/24/28/32/40/48/56/80 px | `--zh-size-*` |
| `$sizeGlobalMaxWidth` / `$sizeWidthContent` / `$sizeWidthTextContent` | 1440 / 1168 / 768 px | `--zh-max-width`, `--zh-content-width`, `--zh-text-width` |
| `$sizeBreakpoint*` | 0/320/400/600/840/1024/1280 px | our media queries use 600/840/1024/1280 |
| `$grid-margin-gutters`/`columnGap` curve | 12→16→24→32 px | `--zh-column-gap`, `--zh-wrapper-gap` |
| `$transitionTimeSimple/Fade/Default`, `$transitionEasing*` | 100/200/250 ms, `ease`, `cubic-bezier(0.01,0.13,0.63,0.99)` | `--zh-transition-*`, `--zh-easing-*` |
| `$zIndexScaffolds/Overlays/Flyouts/Skiplinks` | 100/1000/1100/2000 | `--zh-z-header/overlay/detail/skiplink` |
| `$spinnerColor`, `$spinnerSize`, `$spinnerBorderSize` | `#009ee0`, 24 px, 2 px | `.zh-spinner` |

## Characteristics we reproduced

- **Typography**: `InterRegular` (400) as the text face and `InterBlack` (900) for
  headings and buttons — exactly the two families the canton ships in
  `src/assets/fonts/`. Headings use `letter-spacing: -0.02em`, h1
  `line-height: 1` from 840 px (`$sizeLineHeightNarrower`).
- **Buttons** (`atm-button`): black fill, white text, `border-radius: 1px`,
  48 px height (`$normalButtonSize: $sizeBiggerBig + $sizeTiny` = 40 + 8), 48 px
  min-width, InterBlack label, hover `#333`, disabled `#949494`, plus the
  official `--small` (32 px, `$sizeBig`) variant. Our `--ghost`/`--secondary`
  variants keep the same geometry; icon buttons are square (`--zh-button--icon`).
- **Tags** (`atm-tag`): 12 px text, 2 px border `#ccc`, 5 px radius, 4×8 px
  padding — used for provenance/IIIF/“Kartenausschnitt bekannt” labels.
- **Heading steps 4–6**: `src/atoms/headings/headings.scss` gives `h4`, `h5`
  and `h6` one shared step
  (`@include polyFluidSizing('font-size', map-get($fontSizeCurves, regular))`),
  so `.zh-heading--4/--5` and `h5`/`h6` all render 18 px and 20 px from 840 px.
  The `.mod-smaller-headings` variant (14/16/18 px via the
  `smallModFontSizeH5H6` curve) is not used in this app. `#intro-heading`
  carries `.zh-heading--1` so the document heading follows the cantonal `huge`
  curve 32 → 40 (≥840 px) → 48 px (≥1280 px), with the app's own 28 px step
  below 600 px.
- **Indentation and rules**: section headings carry the 3 px top rule of
  `atm-heading--bordered`; content panels use a 4 px colour bar on the left
  (`--zh-size-mini`, `$sizeMini`) and the 4 px spacing rhythm, mirroring the
  canton's chapter-number indentation (`$chapterNumberMinWidth: 36px`).
- **Phone step (app decision)**: below 600 px the hero band hands its
  “Zahlen und Fakten” strip to the “Über das Projekt” card (`#about-facts`, the
  same values rendered from the same data in `main.js`), and below the cantonal
  400 px breakpoint the brand claim is hidden — the name stays. Both keep the
  map on the first phone screen without dropping information from the page
  (measured 390×844: map top 722 → 609 px, visible map 122 → 235 px; harness
  check “phone map-first …”). The lead paragraph has a second, short sentence
  for phones (`.app-intro__lead-short`): the long one needed 4–8 lines at
  320–430 px and the 2-line clamp cut it mid-word, so the phone band now ends
  on a full stop at every measured width and the clamp is only the safety net;
  the long wording stays in “Über das Projekt”.
- **Form controls**: 2 px black borders, official input scales 72 / 60 / 48 px
  (`form_input.scss`: `$targetInputHeight` 72, `$targetMediumInputHeight` 60,
  `$targetSmallInputHeight` 48), labels in InterBlack at 14 px, 2 px input
  radius. This app is data-dense: the header search uses the official **small**
  step (48 px), the sidebar/toolbar fields use the app's own 32 px step
  (`$sizeBig`, the same value as `atm-button--small`) so the list stays visible,
  and range inputs use the cantonal blue as `accent-color`. The input border is
  black instead of the upstream `#949494` default because a #949494 boundary on
  white is only 2.9:1 — below the 3:1 that SC 1.4.11 asks for.
- **“Nach oben”** (`mdl-back2top`): a fixed 48 px circle (`$sizeSmallHuge`)
  with the cantonal black button fill, a 24 px arrow icon and the upstream
  corner-margin curve (24 → 32 → 40 → 48 px). It appears only once the page is
  scrolled and moves focus to the content start when used (`.app-backtotop`,
  `wireBackToTop()` in `main.js`).
- **Focus**: 3 px `#0070b4` outline with 2 px offset on every interactive
  element via `:focus-visible`; the canton's “flying focus” concept is
  referenced but a plain, high-contrast ring is used for predictability.
- **Accessibility**: skip link, semantic landmarks, `role="status"` live
  regions for result counts/search/status, `aria-expanded`/`activedescendant`
  combobox semantics, keyboard-operable map (arrows, `+`/`-`, Home, End) with an
  equivalent result list, focus management and `Esc` in the detail panel,
  roving tabindex for repeated controls (the year histogram and the sheet strip
  are one tab stop each; ←/→/Home/End move inside them),
  `prefers-reduced-motion` support, and text contrast ≥ 4.5:1 on the token
  palette (black/grey on white/`#f7f7f7`; blue `#00407c` for links).

## Fonts and licences

- `public/fonts/Inter-Regular.woff2`, `public/fonts/Inter-Black.woff2` are the
  files from the canton's repository (Apache-2.0 repo, fonts themselves under the
  **SIL Open Font License 1.1** — see `public/fonts/LICENSE-Inter-OFL.txt`).
- Fallback stack: `'InterRegular', 'Inter', Helvetica, Arial, sans-serif` and
  `'InterBlack', 'Inter', 'Arial Black', Helvetica, sans-serif` — the same
  fallbacks the canton's `_variables.scss` declares. The UI therefore degrades to
  system fonts without layout breakage if the woff2 files are unavailable.
- No cantonal logo, coat of arms or other protected asset is used. `public/
  favicon.svg` and the header mark are our own simplified shield in the
  cantonal blue/white, with the “no government affiliation” note in the header
  bar and footer.

## Verification against the upstream files

On 2026-10-18 the token file and the component geometry were re-read from the
upstream repository (commit
[`552ceb6`](https://github.com/Kanton-Zurich/frontend-designsystem/commit/552ceb670d0cef0ba1b4dd6cf567ebd0edb98915),
`src/assets/css/globals/_variables.scss`, `src/atoms/button/button.scss`,
`src/atoms/form_input/form_input.scss`) and compared with this app:

- every hex colour used anywhere in `public/styles/*.css` is one of the official
  palette values (`#0070b4`, `#00407c`, `#00797b`, `#009ee0`, `#b01657`,
  `#d40053`, `#7f3da7`, `#1a7f1f`, `#e2001a`, the black scale and the soft
  variations);
- the font, spacing, line-height, grid, transition and z-index tokens match the
  upstream values 1:1;
- **correction from that check**: `$normalButtonSize` is `$sizeBiggerBig +
  $sizeTiny` = **48 px**, not 40 px. Buttons/inputs had been built at 40 px and
  the docs repeated the arithmetic error; the control height is now the official
  48 px (`--zh-control-height`) and the 32 px variants use `$sizeBig`.

## Where the implementation lives

| File | Content |
| --- | --- |
| `public/styles/zh-tokens.css` | tokens + `@font-face` |
| `public/styles/zh-base.css` | reset, typography scale, shell/grid (1168 px content), utilities, spinner |
| `public/styles/zh-components.css` | buttons, tags, chips, form controls, panels, cards, header/footer |
| `public/styles/app.css` | product layout (map + list + detail) built from the tokens |

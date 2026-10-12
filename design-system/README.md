# OpenList

A calm file browser for every drive.

OpenList lists and previews files from dozens of cloud drives. The UI is a Hope UI (SolidJS) app with a few site-specific controls layered on top. This system records what that build ships: one blue, neutral surfaces, rounded 6–11px corners and system fonts.

## Content fundamentals

- Plain, short labels: "Upload", "New folder", "Cancel". Sentence case, no punctuation on buttons.
- The interface is bilingual (English and Chinese). Keep labels short enough to survive translation.
- No emoji. Status goes in words and a progress bar.

## Visual foundations

- **Ground:** `surface-100` for the page, `surface-200` for anything raised. Text is `ink`; secondary text is `ink-muted`.
- **One accent:** `brand` fills the primary action; `brand-hover` is its hover. Outline buttons use `brand` ink on a transparent ground with a 1px `brand` border.
- **Corners:** buttons and the quota pill `radius-md`, dialogs and cards `radius-lg`, menus `radius-sm`.
- **Depth:** two shadows only, `shadow-menu` and `shadow-dialog`.
- **Type:** system sans, 16px body, button labels 14.4px semibold.
- **Motion:** buttons scale to 0.95 on press (0.2s); menus fade or scale in over 0.3s. Honor `prefers-reduced-motion`.
- **Focus:** a visible 2px outline in the control's ink, offset 2px.

## Iconography

The app uses its own icon font and drive file-type icons; none is bundled here. Use the mark in `assets/Logos` as shipped.

## Rules by token

- Text on `brand` must be 14px or larger and semibold; it measures 3.7:1, so never use it for body copy.
- Use `brand-tint` for hover fills, never `brand` at reduced opacity.
- One primary button per dialog.

## Components

Button, Dialog, ContextMenu and DriveQuota are static renditions written from the CSS in `dist/index.html` and `dist/assets/style-*.css`. There is no component bundle.

## Not synced

The repository holds the Cloudflare Worker backend; the front-end source is not checked in, so values come from the compiled `dist/` output. Hope UI's default palette and scales are inherited by the app but were not read. Dark values called "derived" are mine. `SourceHanSansCN-Bold.woff2` ships with the app but was not copied.

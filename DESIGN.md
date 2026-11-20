---
name: tweets-2-bsky
description: A self-hosted mirror operator's dashboard that reads every Twitter-to-Bluesky mirror as a forwarding route, transit time first.
colors:
  # Light theme (aerogramme paper). Values are the OKLCH triplets in web/src/index.css :root.
  airmail-blue: "oklch(43% 0.165 264)"
  airmail-blue-ring: "oklch(52% 0.15 264)"
  aerogramme-paper: "oklch(96.8% 0.011 250)"
  sheet: "oklch(98.8% 0.005 250)"
  sorting-rail: "oklch(94% 0.017 252)"
  franking-tint: "oklch(93.5% 0.016 252)"
  hairline: "oklch(88.5% 0.02 252)"
  field-edge: "oklch(86% 0.024 252)"
  faded-ink: "oklch(48% 0.032 258)"
  postal-ink: "oklch(25% 0.045 262)"
  on-airmail: "oklch(98.5% 0.005 250)"
  cancellation-red: "oklch(53% 0.19 27)"
  customs-amber: "oklch(50% 0.125 62)"
  cleared-green: "oklch(50% 0.1 165)"
  tracking-blue: "oklch(50% 0.12 240)"
  # Dark theme (postal navy). Values are the OKLCH triplets in web/src/index.css .dark.
  airmail-blue-dark: "oklch(74% 0.115 258)"
  postal-navy: "oklch(20% 0.035 263)"
  sheet-dark: "oklch(22.5% 0.04 263)"
  sorting-rail-dark: "oklch(17.5% 0.034 263)"
  franking-tint-dark: "oklch(26% 0.04 263)"
  hairline-dark: "oklch(30.5% 0.042 263)"
  field-edge-dark: "oklch(35% 0.045 263)"
  faded-ink-dark: "oklch(73% 0.03 255)"
  postal-ink-dark: "oklch(94% 0.012 250)"
  on-airmail-dark: "oklch(19% 0.04 263)"
  cancellation-red-dark: "oklch(70% 0.165 25)"
  customs-amber-dark: "oklch(80% 0.125 78)"
  cleared-green-dark: "oklch(76% 0.11 165)"
  tracking-blue-dark: "oklch(76% 0.1 235)"
typography:
  headline:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: "1.75rem"
    letterSpacing: "-0.015em"
  title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.5rem"
  title-sm:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.375
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
    fontFeature: "\"tnum\" 1, \"cv11\" 1"
  control:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: "1.25rem"
  control-sm:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: "1.25rem"
  label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
  micro:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: "1rem"
  figure:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.5rem"
    fontFeature: "\"tnum\" 1"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  full: "9999px"
spacing:
  hair: "2px"
  xs: "6px"
  sm: "8px"
  row: "10px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
  gutter-wide: "40px"
components:
  button-primary:
    backgroundColor: "{colors.airmail-blue}"
    textColor: "{colors.on-airmail}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "oklch(43% 0.165 264 / 0.9)"
  button-primary-sm:
    backgroundColor: "{colors.airmail-blue}"
    textColor: "{colors.on-airmail}"
    typography: "{typography.control-sm}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-outline:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.postal-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "40px"
  button-outline-hover:
    backgroundColor: "{colors.franking-tint}"
  button-ghost:
    textColor: "{colors.faded-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
  button-ghost-hover:
    backgroundColor: "{colors.franking-tint}"
    textColor: "{colors.postal-ink}"
  button-subtle:
    backgroundColor: "{colors.franking-tint}"
    textColor: "{colors.postal-ink}"
    rounded: "{rounded.md}"
  button-destructive:
    backgroundColor: "{colors.cancellation-red}"
    textColor: "{colors.aerogramme-paper}"
    rounded: "{rounded.md}"
  button-icon:
    rounded: "{rounded.md}"
    size: "32px"
  badge-danger:
    backgroundColor: "oklch(53% 0.19 27 / 0.1)"
    textColor: "{colors.cancellation-red}"
    typography: "{typography.micro}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
  badge-warning:
    backgroundColor: "oklch(50% 0.125 62 / 0.1)"
    textColor: "{colors.customs-amber}"
    typography: "{typography.micro}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
  badge-success:
    backgroundColor: "oklch(50% 0.1 165 / 0.1)"
    textColor: "{colors.cleared-green}"
    typography: "{typography.micro}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
  badge-outline:
    textColor: "{colors.faded-ink}"
    typography: "{typography.micro}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
  input:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.postal-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "36px"
  input-compact:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.postal-ink}"
    typography: "{typography.control-sm}"
    rounded: "{rounded.md}"
    height: "32px"
  card:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.postal-ink}"
    rounded: "{rounded.lg}"
    padding: "16px 20px"
  rail:
    backgroundColor: "{colors.sorting-rail}"
    width: "208px"
  nav-item:
    textColor: "{colors.faded-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
  nav-item-active:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.postal-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
  segmented-control:
    backgroundColor: "{colors.sorting-rail}"
    rounded: "{rounded.md}"
    padding: "2px"
  segmented-control-active:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.postal-ink}"
    typography: "{typography.control-sm}"
    height: "28px"
  dropdown-menu:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.postal-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "4px 0"
    width: "208px"
  route-row:
    typography: "{typography.body}"
    padding: "10px 0"
  transit-bar:
    rounded: "{rounded.full}"
    height: "12px"
  airmail-mark:
    rounded: "5px"
    size: "20px"
---

# Design System: tweets-2-bsky

## Overview

**Creative North Star: "Airmail Forwarding"**

Every mirror is a forwarding route, and the dashboard reads transit time first. The ground is aerogramme paper in light mode (a pale, blue-cast sheet) and postal navy in dark mode; both are drawn from one blue-tinted neutral ramp so that rails, rules, muted text and fills all feel like the same stationery. Airmail blue is the only colour that asks to be pressed. Cancellation-ink red is reserved for routes that are late, down or failing; customs amber marks slow. Healthy routes stay quiet: neutral ink, a short dot-to-dot tick, nothing lit.

The system is dense and operational, built for one admin scanning 60 to 80 routes from a desk or a phone. Structure comes from hairline rules between rows and groups, not from boxed cards; the routes table is a ruled ledger grouped by standing (Needs attention, Slow, On time, No data), sorted slowest first. One system sans family carries every size, with tabular figures on by default, so durations and counts line up in columns without a monospace face. The only ornament is the airmail etiquette stripe, which is the product mark and appears nowhere else.

Light and dark are equal citizens. The theme follows the operating system by default with an Auto / Light / Dark override in the rail foot; the choice is resolved before first paint so a dark reload never flashes paper. The rejected default is the KPI-card-grid admin: stat tiles and a wall of cards.

**Key Characteristics:**
- One blue-tinted neutral ramp in both themes; no grey from outside it.
- Airmail blue is the single action and brand colour; red and amber are state, never decoration.
- Hairline rules over filled boxes; small radii (4 to 8px).
- One system sans at every size, tabular figures everywhere.
- The per-route transit bar is the signature; the airmail stripe is the mark.
- Calm at rest: colour appears only where a route needs a human.

## Colors

A cool, low-chroma postal palette: blue-cast paper and ink, one saturated airmail blue for action, and three state inks that only speak when something is off.

### Primary
- **Airmail Blue** (light `airmail-blue`, dark `airmail-blue-dark`): primary buttons (Run now), active nav icon, links, the "show more" action, the running-job dot, the volume dot (at 70%), selection tint (22%), caret and native checkbox/radio accent. The focus ring uses the slightly lighter **Airmail Blue Ring** in light and the same airmail blue in dark. Text on it is **On-Airmail** (near-white paper in light, navy in dark).

### Secondary
- **Cancellation Red** (`cancellation-red` / `cancellation-red-dark`): late, down, failed. The Needs attention group label, a late route's transit bar and figure, "failed to post" lines, the danger badge, the destructive button, the unavailable-accounts banner (tinted at 7% with a 40% border). Also the red stripe in the airmail mark.
- **Customs Amber** (`customs-amber` / `customs-amber-dark`): slow (10 to 30 minute average transit), source-side errors such as a protected X account, the warning badge, "stuck" counts.

### Tertiary
- **Cleared Green** (`cleared-green` / `cleared-green-dark`): success badges and success notices only. It is not used for on-time routes; on time is plain ink.
- **Tracking Blue** (`tracking-blue` / `tracking-blue-dark`): informational accents (the remapped `sky`/`cyan` utilities).

### Neutral
- **Aerogramme Paper** (`aerogramme-paper`) / **Postal Navy** (`postal-navy`): the page ground.
- **Sheet** (`sheet` / `sheet-dark`): one step lifted from the ground. Cards, inputs, outline buttons, menus, the active nav item and active segment.
- **Sorting Rail** (`sorting-rail` / `sorting-rail-dark`): the left navigation rail, the mobile sticky header (at 95% with backdrop blur) and the track of segmented controls. In light it sits slightly darker than paper; in dark it sits below navy.
- **Franking Tint** (`franking-tint` / `franking-tint-dark`): muted and secondary fills, hover fills, skeleton bars, the "no samples yet" note.
- **Hairline** (`hairline` / `hairline-dark`): every rule and border by default (applied globally to `*`). Row dividers use it at 70%.
- **Field Edge** (`field-edge` / `field-edge-dark`): input and outline-button borders; hover darkens the edge to ink at 25%.
- **Faded Ink** (`faded-ink` / `faded-ink-dark`): secondary text, column headers, `dt` labels, inactive nav, placeholders.
- **Postal Ink** (`postal-ink` / `postal-ink-dark`): primary text and headings. Ink at 35% draws an on-time transit bar; ink at 3 to 5% is the row hover and expanded-row wash.

### Named Rules
**The One Stamp Rule.** Airmail blue is the only colour that means "press this". Nothing decorative is blue; nothing pressable is red unless it destroys something.

**The Cancellation Ink Rule.** Red appears only when a route is late, down or has failed posts, and amber only when it is slow or its source is erroring. A screen with every route healthy has no red and no amber on it.

**The One Ramp Rule.** Every neutral comes from the blue-tinted ramp (hue 250 to 263). Raw Tailwind palette names are remapped in `tailwind.config.cjs` so `red`/`rose` resolve to the late token, `amber`/`yellow`/`orange` to slow, `emerald`/`green` to ok, `sky`/`cyan` to info and `blue`/`indigo` to primary; stock Tailwind hues never render.

## Typography

**Display Font:** none (the system has no display face)
**Body Font:** system-ui (with -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif)
**Label/Mono Font:** ui-monospace (with SFMono-Regular, Menlo, Consolas, monospace) for handles, IDs and log lines only

**Character:** One quiet operating-system sans at every size, with tabular figures (`"tnum" 1, "cv11" 1`) set on `body` so every number in the app aligns. Hierarchy comes from weight (400 / 500 / 600) and a tight size ladder, not from a second family.

### Hierarchy
- **Headline** (600, 20px on phones, 22px from 640px up, 28px line, -0.015em): the page title in the content header, one per view.
- **Title** (600, 16px, 24px line): section headings such as Routes and Instance.
- **Title Small** (600, 15px, 1.375): card titles and the wordmark in the rail (the wordmark adds -0.01em tracking).
- **Body** (400, 14px, 20px line): table cells, descriptions, nav items, menu items.
- **Control** (500, 14px) and **Control Small** (500, 13px): button labels; 13px is the compact size used for small buttons, filter inputs, sort selects and segmented tabs.
- **Label** (400, 12px, 16px line): column headers, `dt` labels, sub-lines under a route ("from @handle"), standing group headers, hints.
- **Micro** (500, 11px, 16px line): badges, theme switcher segments, dropdown section labels. 11px is the floor.
- **Figure** (600, 16px, tabular): the headline summary number (Average transit), coloured by standing.

### Named Rules
**The One Family Rule.** One sans family at every size. Do not introduce a display face; the page title earns its rank from weight and size alone.

**The Tabular Figures Rule.** Every duration, count and timestamp uses tabular figures; they are on globally, so never turn them off, and add `tabular-nums` explicitly where a number sits in a column.

## Layout

A fixed left rail plus a single content column. From 1024px up, the rail is a sticky, full-height 208px column on Sorting Rail with a hairline right edge: wordmark and airmail mark at the top, the section list (Overview, Accounts, Posts, Activity, Settings), and a foot carrying next-run countdown, version, the theme switcher and sign out. Below 1024px the rail becomes a sticky top bar (Sorting Rail at 95% with backdrop blur) holding the mark, wordmark, next-run countdown and a horizontally scrolling row of 36px tab buttons.

Content is centred at a 72rem (1152px) maximum with 16px side gutters on phones, 24px from 640px and 40px from 1024px; vertical padding is 24px, 32px from 1024px. Each view opens with a header row: headline plus one-line description on the left, Add account (outline) and Run now (primary) on the right, wrapping on narrow screens. Sections stack with 32px between them and are separated by a hairline top rule with 24px above the heading, not by card boundaries.

The routes table is a CSS grid: route, transit bar, worst, last post, checked, chevron (`1.5fr 1.6fr 4.5rem 5.5rem 6rem 1rem`) from 768px; below that it collapses to route plus chevron with the transit bar spanning the full width underneath. Rows are 10px top and bottom, divided by hairlines. On-time groups longer than 12 rows show the first 8 and a "Show N more on-time routes" action. Long lists use `content-visibility: auto` so 80 rows stay cheap.

Accounts uses a 200px folder column beside the list from 1024px; below that the folders become a horizontal chip scroller. Form inputs are forced to 16px on phones to stop iOS zoom.

## Elevation & Depth

Flat by default. Depth comes from tonal layering: ground (paper or navy), rail (one step darker), sheet (one step lifted). Hairlines do the separating. Shadows are tinted with the ink colour, never neutral black, and are reserved for three cases: the single selected item in a list or segmented control (a 1 to 2px lift), floating surfaces that sit over content (dropdown menu, login card, add-account sheet), and nothing else.

### Shadow Vocabulary
- **Selected lift** (`box-shadow: 0 1px 2px oklch(var(--foreground) / 0.08)` on the active nav item; `/ 0.1` on the active segment of a segmented control): marks the one chosen item as a sheet resting on the rail.
- **Menu float** (`box-shadow: 0 8px 24px -6px oklch(var(--foreground) / 0.18), 0 2px 4px oklch(var(--foreground) / 0.06)`): dropdown menus.
- **Login card float** (`box-shadow: 0 12px 32px -12px oklch(var(--foreground) / 0.18)`): the sign-in card, the only card that floats.

### Named Rules
**The Flat Ledger Rule.** Rows, tables, sections and resting cards carry no shadow. If something needs separating, rule it with a hairline.

## Shapes

Small, consistent corners: 4px on badges and the smallest segments, 6px on buttons, inputs, nav items and segmented controls, 8px on cards and menus, full round only on dots (volume dot, transit-bar posts, running-job dot) and the transit bar's run. The airmail mark is a 20px square at 5px radius (16px at 4px in the mobile bar, 24px at 6px on the login card) with an inset ink ring at 10%.

Borders are 1px hairlines. Rules run horizontally between rows and groups; vertical rules appear only on the rail edge. The transit bar is the system's one recurring geometry: a 1px hairline track, a 3px rounded run from a left dot to an 8px end post, and a faint 1px tail to the worst case.

## Components

### Buttons
Compact and plain: flat fills, no shadow, a 1px press-down on active.
- **Shape:** gently rounded (6px).
- **Primary:** Airmail Blue fill, On-Airmail text, 40px tall with 16px side padding (default) or 32px tall with 12px padding and 13px label (small, the size used in headers and toolbars). Hover drops the fill to 90%.
- **Outline:** Sheet fill, Field Edge border, Postal Ink text; hover darkens the border to ink at 25% and fills Franking Tint. Used for Add account, Try again, Open account, and icon-only refresh.
- **Ghost:** no fill, Faded Ink text; hover fills Franking Tint and lifts text to Postal Ink.
- **Subtle:** Franking Tint fill, Postal Ink text.
- **Destructive:** Cancellation Red fill with paper-coloured text; reserved for actions that remove something.
- **Icon:** 32px square.
- **Hover / Focus:** 150ms ease-out colour transitions; focus shows a 2px Airmail Blue Ring ring with a 2px offset; disabled is 50% opacity with pointer events off.

### Chips (Badges)
- **Style:** 11px medium text, 4px radius, 2px by 6px padding, 1px border.
- **State:** danger (red text on 10% red, 30% red border), warning (amber on 10% amber, 30% border), success (green on 10% green, 25% border), outline (Faded Ink text, hairline border, e.g. "paused"), secondary (Postal Ink on Franking Tint), default (Airmail Blue fill).

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** Sheet.
- **Shadow Strategy:** none at rest (see Elevation).
- **Border:** 1px hairline. The unavailable-accounts banner swaps to a 40% red border with a 7% red header band.
- **Internal Padding:** 16px, rising to 20px horizontal from 640px. Card titles are Title Small (15px semibold).
- Cards hold forms and settings groups. The Overview's routes and instance facts are not cards; they are ruled sections.

### Inputs / Fields
- **Style:** Sheet fill, 1px Field Edge border, 6px radius, 36px tall, 12px side padding, 14px text, Faded Ink placeholder. The compact variant (filters, sort select) is 32px with 13px text.
- **Hover:** border darkens to ink at 25%.
- **Focus:** 2px Airmail Blue Ring ring, 2px offset; caret and native accents are Airmail Blue.
- **Disabled:** 50% opacity, not-allowed cursor.

### Navigation
- **Rail list:** 14px items, 6px by 10px padding, 6px radius, 16px icons, 2px gap. Inactive items are Faded Ink with an ink-at-5% hover. The active item is a Sheet tile with a hairline ring and the selected lift, medium weight, and its icon turns Airmail Blue.
- **Segmented control:** a 2px-padded Sorting Rail track with a hairline border; segments are 28px tall at 13px (Activity views) or 24px at 11px with 12px icons (theme switcher). The active segment is a Sheet tile with the selected lift.
- **Mobile:** the sticky top bar's tab buttons are 36px tall; active is a Sheet tile with a hairline ring.
- **Dropdown menu:** an 8px-radius Sheet panel with a hairline border and the menu float shadow, at least 208px wide, 4px vertical padding; items are 14px with 8px by 12px padding and a Franking Tint hover; destructive items are red with a 10% red hover. Opens with a 150ms fade-and-drop.

### Route Row and Transit Bar (signature)
The routes table is the heart of the system. Each row is a full-width button divided by a 70% hairline: a **volume dot** (post count on a fixed size ramp: a 4px hollow ring for zero, then 5, 7, 9, 11px filled at 70% Airmail Blue), the Bluesky handle in medium weight, state badges, and a 12px Faded Ink "from @source" sub-line; problem lines follow in red or amber. The **transit bar** runs log-scaled from 30 seconds to 4 hours: a hairline track, a 3px run from a left post to an 8px end post (ringed in Sheet), and a half-opacity 1px tail out to the worst case. On-time routes draw in ink at 35%, slow in Customs Amber, late in Cancellation Red, so a late route reads as a long red run while on-time ones are a short grey tick. The average figure sits right of the bar in tabular medium type, coloured by standing. Hover and the expanded state wash the row with ink at 3%; the chevron rotates 90 degrees over 150ms; the expanded panel shows median, 95th percentile, worst, sampled, posted and queued as a label-over-value grid.

Standing groups open with a 12px header on a hairline: the standing name in semibold (red for Needs attention, amber for Slow, ink otherwise), the count in Faded Ink, and a one-line threshold hint from 640px.

### Airmail Mark
The product mark: a small rounded square filled with a 135-degree repeating stripe of cancellation red (4px), sheet (3px), airmail blue (4px), sheet (3px), with a 10% inset ink ring. It sits beside the wordmark in the rail, the mobile bar and the login card.

## Do's and Don'ts

### Do:
- **Do** use Airmail Blue (`airmail-blue` / `airmail-blue-dark`) for the one primary action per header and for links; keep everything else neutral.
- **Do** colour a route, figure or label red only when it is late (over 30 minutes average), down or has failed posts, and amber only when it is slow (10 to 30 minutes) or its source is erroring.
- **Do** separate rows and sections with 1px hairlines (`hairline`, 70% for row dividers) instead of wrapping them in cards.
- **Do** keep the routes table grouped by standing with Needs attention first, sorted slowest first, and collapse long on-time groups.
- **Do** use the single system sans with tabular figures for every number; set durations in the compact one-unit-pair form (`4m`, `1h 20m`).
- **Do** define every new colour as an OKLCH triplet in both `:root` and `.dark`, drawn from the blue-tinted ramp, and expose it through `tailwind.config.cjs`.
- **Do** keep transitions at 150ms ease-out for state changes and respect `prefers-reduced-motion` (all motion collapses to 1ms).
- **Do** show focus with the 2px Airmail Blue Ring ring and 2px offset on every interactive element.

### Don't:
- **Don't** build KPI stat tiles or a wall of cards; summary numbers sit inline as label-and-value pairs on the header line.
- **Don't** use red, amber or green as decoration, category colour or emphasis on healthy state; on time is plain ink, not green.
- **Don't** use stock Tailwind hues, neutral greys or pure black and white; every neutral comes from the blue-tinted ramp.
- **Don't** reuse the airmail stripe as a pattern, divider or background anywhere; it is the product mark and nothing else.
- **Don't** add a second type family or a display face, and don't set text below 11px.
- **Don't** put shadows on resting rows, sections or cards; shadows mark the single selected item or a surface floating over content.
- **Don't** use uppercase, letter-spaced labels (eyebrows or kickers) above headings.
- **Don't** exceed 8px radius on in-flow surfaces.

# MTechno Absolute Control & Glass UI

A userscript that replaces the browser's page scrollbar with an overlay scrollbar and adds eased mouse-wheel scrolling, markers for headings and selected text, personal pins, and reading-position memory.

It is a single file with no dependencies, makes no network requests, and runs on every http and https page (top-level frames only).

## Installation

1. Install a userscript manager. The script is written for [Tampermonkey](https://www.tampermonkey.net/). It uses the synchronous `GM_addStyle`, `GM_getValue`, `GM_setValue` and `GM_registerMenuCommand` functions, so Violentmonkey should also work. Greasemonkey 4 does not provide the synchronous storage functions and is not supported.
2. Open `advanced-scrollbar v21.user.js` in this repository and choose **Raw**. The userscript manager will offer to install it.
3. Reload the pages you want to use it on.

To update, install the newer file. Settings and saved data are kept.

The script needs a browser with Shadow DOM, Pointer Events and CSS custom properties, which covers current releases of Chrome, Edge, Firefox and Safari. It cannot run on pages where the userscript manager is not allowed to inject, such as browser-internal pages, extension stores and built-in PDF viewers.

## Features

### Scrollbar

- Replaces the viewport's vertical and horizontal scrollbars. The bar is drawn inside a closed Shadow DOM, so page CSS cannot restyle or hide it. Other scrollable elements on the page keep their native scrollbars.
- Sits flush against the right edge. The hit area is a fixed 14 px wide strip. The thumb is 10 px wide and widens to 14 px while the pointer is over the strip.
- Fades out 900 ms after the last scroll and returns on scroll or hover. It stays visible while hovered or dragged. A menu option keeps it always visible.
- Dragging the thumb scrolls 1:1 and shows the position as a percentage, with the name of the current section when the page has section markers.
- Clicking the empty track scrolls one page toward the pointer. Holding the button repeats and stops when the thumb reaches the pointer.
- A horizontal bar appears at the bottom when the page overflows horizontally, unless `overflow-x` is hidden.
- While the pointer is over the track, the part above the thumb is shaded slightly to show how far into the page you are.
- The thumb colour follows the page behind it. A light page gets a dark translucent thumb, a dark page gets a light one. The choice uses hysteresis so it does not flicker near the threshold.
- The bar is hidden when the page has no scroll range, when scrolling is locked with `overflow: hidden` (for example behind an open modal), and when printing.
- With the operating system's forced-colors mode (Windows High Contrast) the bar, markers and labels use system colours instead of translucent glass.

### Smooth scrolling

- Mouse-wheel input moves a target position, and the page is eased toward it. The easing is independent of the display's refresh rate.
- Rapid wheel notches build up speed, up to 2.5 times a single notch with the default preset. Reversing direction discards the remaining distance, so the page responds immediately. Trackpad input (small pixel deltas) is applied 1:1 with no acceleration.
- Four presets are available from the menu:

  | Preset | Easing factor per frame at 60 Hz | Maximum acceleration |
  | --- | --- | --- |
  | Soft | 0.09 | 2.0 |
  | Balanced (default) | 0.13 | 2.5 |
  | Fast | 0.20 | 3.2 |
  | Off (instant) | none | none |

  "Off (instant)" disables the animation but keeps the scrollbar and every other feature.
- Keyboard: arrow keys scroll 80 px, Page Up, Page Down and Space scroll 88% of the viewport height, Home and End go to the ends.
- The system setting `prefers-reduced-motion: reduce` turns the animation off.

The script leaves scrolling to the browser in these cases:

- Ctrl, Shift, Alt or Meta is held, or the gesture is mainly horizontal.
- The wheel is over a nested scrollable element that can still scroll in that direction. When that element reaches its end, the page waits 350 ms before taking over.
- For keys: focus is in a text field, select, button, media element or an element with an interactive ARIA role, or Shift is held with an arrow key.
- The page uses scroll snapping, or the window has no scroll range (content scrolls inside a panel).
- The page ships its own smooth-scrolling engine. Detection is based on class names and attributes used by Lenis, Locomotive Scroll, fullPage.js, pagePiling.js and GSAP ScrollSmoother.
- The page ignores the script's scroll calls. After three consecutive attempts in which the page does not move at all, the script uses native scrolling on that page for 60 seconds.

Every animation starts from the page's real scroll position. If something else moves the page during an animation, the script drops its animation rather than fighting it.

### Section markers

- Collects `h1` and `h2` headings and draws a small tick for each on the track, visible while the pointer is over the track. `h1` ticks are wider.
- Hovering a tick shows the heading text and its position in the page. Clicking it scrolls there.
- Headings inside `nav`, `footer`, `[hidden]` or `[aria-hidden="true"]` are ignored, as are fixed or sticky headings. Headings closer than 24 px to each other are merged.
- Markers are drawn only when there are between 2 and 40 headings and the page's scroll range (content height minus the visible height) is at least half a viewport.
- Jumps land with a margin above the heading. The margin is the height of a fixed or sticky bar at the top of the viewport plus 12 px, the heading's own `scroll-margin-top` if larger, or 16 px when neither applies. The bar is detected by sampling the elements at three points along the top edge of the viewport.

### Selection markers

- When you select 2 to 80 characters of single-line text, every other occurrence on the page gets an amber mark on the track. The colour matches the browser's find-in-page highlight.
- Matching is case-insensitive. If the selection is a single word, only whole words match, so selecting "art" does not mark "party".
- Hovering a mark shows the surrounding text and the position among the matches, for example `2 / 4`. Clicking scrolls so the match sits about 30% from the top of the viewport.
- Marks appear only when there are at least two matches and at most 400. Marks closer than 3 px are merged. Hidden text is skipped.
- The page is scanned in short slices of about 8 ms so scrolling stays responsive. A scan that takes longer than 2.5 seconds is abandoned.
- Selections inside text fields or editable elements are ignored. Matches are found within a single text node, so a phrase that spans inline elements such as `<b>` may produce fewer matches.
- Clicking the scrollbar does not clear the selection.

### Pins

- `Alt+M` drops a pin at the current position. Pressing it again near the same position (within 20% of the viewport height) removes it.
- Pins are drawn as blue flags on the left side of the track. Each pin remembers the section it was placed in.
- `Alt+Shift+Up` and `Alt+Shift+Down` move to the previous and next pin.
- Up to 30 pins per page. Pins are stored per page for up to 365 days, for up to 150 pages.
- If a pin and a section tick are at the same spot, the pin wins when hovering.

### Resume where you left off

- On pages whose scroll range is at least three viewports, the script remembers how far you read. When you open the same page from the top later, a chip reading "Resume where you left off" shows the saved position as a percentage. Clicking it scrolls there. The x button dismisses it and forgets that page.
- A position is saved when you scroll past the first screen, when the tab is hidden, and when the page is unloaded. It is cleared when you reach the last 60% of a viewport at the end of the page.
- The chip stays hidden when the page is short, when the address has a `#hash`, when the browser has already restored a scroll position, when the saved position is within about one viewport of the top or near the end, or when the entry is older than 30 days.
- It appears about a second after the page loads, waits up to 6 seconds for a page that is still growing, and is shown for 14 seconds. It also disappears on Escape and when you scroll away from the top yourself.
- Entries are kept for 30 days, for up to 200 pages.
- Pages are identified by their address without the `#hash` and without common tracking parameters (`utm_*`, `fbclid`, `gclid`, `mc_*`, `ref`, `ref_*`).

### Back to previous position

After a long jump, a chip reading "Back to previous position" appears for 7 seconds. It returns you to where you were. A long jump is more than 1.2 viewports and includes clicking a marker, Home and End, section and pin jumps, and resuming. Dragging the thumb more than 1.5 viewports also offers it. The chip disappears once you return near the starting point by any means.

### Performance and safety

- **Lite mode.** The translucent surfaces use a background blur, which is costly on some hardware. In the default Auto setting, if more than 35% of 40 consecutive animation frames take longer than 28 ms, the script turns the blur off for that page and shows a short notice. Lite and Full can be forced from the menu.
- **Fail-open.** If the script's own code throws five errors on a page, it removes its scrollbar and restores the native one for that page.
- **Reattachment.** If a page removes the scrollbar element from the document, the script puts it back. Retries triggered by mutations are rate-limited to avoid a tug of war with the page.
- **Per-site switch.** Any site can be disabled from the menu. The page reloads and the script does nothing there.
- **Experimental inner scrolling.** Off by default. Many web apps scroll inside a panel instead of the window. When this option is on, wheel input over such a panel is eased the same way as the page. Text areas, selects, inputs, editable elements and scroll-snap panels are never touched. A panel that ignores the script's scroll calls is returned to the browser after three attempts.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Arrow Up / Down | Scroll 80 px |
| Page Up / Page Down | Scroll 88% of the viewport |
| Space / Shift+Space | Scroll one page down / up |
| Home / End | Top / bottom of the page |
| Alt+Up / Alt+Down | Previous / next section |
| Alt+M | Add or remove a pin at the current position |
| Alt+Shift+Up / Alt+Shift+Down | Previous / next pin |
| Escape | Dismiss the resume chip and the shortcuts card |

Keys are ignored while focus is in a text field or another interactive element, and when Ctrl or Meta is held.

## Menu commands

These appear in the userscript manager's menu for the page.

| Command | Effect |
| --- | --- |
| MTechno: disable / enable on this site | Turns the script off or on for the current host and reloads the page |
| Scrolling speed: Soft / Balanced / Fast / Off (instant) | Chooses the easing preset |
| Section markers: toggle on/off | Heading ticks on the track |
| Selection markers: toggle on/off | Marks for occurrences of selected text |
| Resume chip: toggle on/off | Recording positions and showing the resume chip |
| Saved data: clear reading positions and pins | Deletes all stored positions and pins for every page |
| Visual effects: cycle auto / lite / full | Background blur policy |
| Experimental: smooth inner scroll areas, toggle on/off | Easing for scrollable panels inside pages |
| Keyboard shortcuts: show | Shows the shortcuts card |
| Scrollbar: toggle always visible / auto-hide | Whether the bar fades out when idle |
| Diagnostics: show status of this page | Shows what the script is doing on the current page |

## Stored data

Everything is kept in the userscript manager's own storage on your machine. The script does not send anything anywhere.

| Key | Content |
| --- | --- |
| `speed`, `sections`, `selmarks`, `resume_on`, `inner`, `perf`, `always` | Your settings |
| `off:<hostname>` | Sites where the script is disabled |
| `resume` | For each remembered page: the address (without hash and tracking parameters), scroll position, and a timestamp |
| `pins` | For each page with pins: the address, pin positions, the section name for each pin, and a timestamp |

The resume and pins data therefore contain page addresses. The script cannot tell whether a tab is a private window, so positions are saved there too. Use "Saved data: clear reading positions and pins" to delete them, or switch the resume chip off.

## Limitations

- Only `h1` and `h2` headings are used for section markers. Headings inside Shadow DOM or iframes are not found.
- The sticky-header detection is a heuristic that samples three points near the top edge. Unusual layouts can defeat it, in which case jumps use the default 16 px margin.
- Pages that scroll the `body` element or an inner container instead of the window are not eased unless the experimental inner-scrolling option is on.
- The scrollbar is always on the right, including on right-to-left pages.
- Touch devices are not a target. The script does not change touch scrolling.
- Known smooth-scrolling libraries are detected by class names and attributes only.

## Troubleshooting

Run **Diagnostics: show status of this page** from the menu. It reports one of: working (with the scroll range, preset, number of sections and pins, and effects mode), disabled after repeated errors, native scrolling because of a page's own smooth-scroll library, temporarily native because the page ignores scroll calls, locked scrolling, a window that cannot scroll, or scroll snapping.

If scrolling feels wrong on one site, try in this order: set "Scrolling speed" to "Off (instant)", set "Visual effects" to "Lite", then disable the script on that site.

When reporting an issue, include the page address, the Diagnostics message, the browser and userscript manager with their versions, and what you expected to happen.

## Configuration

The tuning values are constants near the top of the file (`CFG` and `SPEEDS`), for example the hit-area width, the fade delay and the marker reach. Edits made to an installed copy are overwritten when the script updates.

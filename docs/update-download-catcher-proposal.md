# Proposal: interactive download catcher for FitGirl update hosters

## Problem

`resolveAutomaticFitGirlUpdates` (src/main.ts) unlocks each update's FileCrypt
container and then filters the links to FuckingFast only, throwing
`No supported FuckingFast files found` otherwise. In practice FitGirl update
containers usually resolve to obscure one-off hosters, so the automated update
path dies exactly when it's needed. The initial-install FileCrypt branch in
`request-dl` has the same FuckingFast-only filter and the same failure mode.

These hosters are ad-ridden, captcha-gated, and too varied to script per-site.
The steamrip-addon solved this with an interactive catcher (`Unknown.ts`): open
a real browser with adblock, let the user click the download button, and catch
the outgoing download via CDP instead of letting it run.

## Verified groundwork

- **OGI accepts per-file headers.** `@ogi-sdk/connect` types
  (`build/index.d.mts:197`): `files: { name, downloadURL, headers?: Record<string,string> }[]`
  for `downloadType: "direct"`. steamrip-addon already ships headers this way
  in production, so the client honors them. The addon only needs to *resolve*
  URLs — OGI downloads.
- **The CDP catcher pattern works without downloading.**
  `Browser.setDownloadBehavior { behavior: "allow", eventsEnabled: true }` +
  a `Browser.downloadWillBegin` listener yields the real download URL and
  suggested filename; `Browser.cancelDownload` stops the transfer immediately
  (steamrip `BaseService.downloadCatcher`). Response headers for the caught
  URL come from `Network.responseReceived` or an in-page HEAD fetch
  (steamrip `Unknown.ts`).
- **Adblock in a real browser is a solved combo.** steamrip passes
  `puppeteer-extra-plugin-adblocker` (`{ blockTrackers: true,
  blockTrackersAndAnnoyances: true, useCache: true }`) into
  puppeteer-real-browser's `connect`. fatboy already depends on
  puppeteer-real-browser + puppeteer-extra; only the adblocker plugin is a new
  dependency.
- **Popup storms are handled** by a `browser.on("targetcreated")` hook that
  closes any page that isn't the working tab (steamrip `closePopupPages`).
- **fatboy already has the service matcher** (`src/matcher.ts` — hostname →
  `{ name, priority }` with `rankDownloadLinks`), so "is this FuckingFast or
  something obscure?" is one call.

## Design

### 1. New module `src/download-catcher.ts`

One exported entry point:

```ts
export type CaughtDownload = {
	downloadURL: string;
	suggestedFilename: string | null;
	headers: Record<string, string>;
};

export async function catchUserDownloads(
	links: { name: string; url: string }[],
	options: {
		onStatus: (message: string) => void;   // event.log passthrough
		timeoutMsPerLink?: number;              // default 5 min, like steamrip
	},
): Promise<CaughtDownload[]>
```

Behavior:

- Launch **one** non-headless puppeteer-real-browser session for the whole
  batch (`turnstile: true`, adblocker plugin) and iterate links in it —
  steamrip launches per-link; batching avoids repeated Chrome starts and keeps
  the adblock engine cache warm.
- Per link: arm the CDP catcher *before* navigating (downloads triggered
  instantly on load are still caught), auto-close popups, navigate, and wait
  up to the timeout for `Browser.downloadWillBegin`. On catch:
  `Browser.cancelDownload`, then capture headers (Referer to the hoster page,
  plus cookies via `Network.getCookies` for the download URL's domain) and the
  filename (`suggestedFilename`, falling back to the URL path).
- User-facing flow: the browser tab *is* the UI — the user solves whatever
  captcha the hoster shows and presses its download button; we never fight
  the site.

### 2. Generalize update resolution (src/main.ts)

Replace the FuckingFast-only filter in `resolveAutomaticFitGirlUpdates`:

1. Unlock the container (unchanged).
2. `rankDownloadLinks(unlocked)` — dedupe by URL as today.
3. If FuckingFast links exist → existing fully-automated
   `resolveFuckingFastUpdateFiles` path, zero interaction (unchanged fast path).
4. Otherwise → one `event.askForInput` notice up front ("N update files need
   manual clicks; a browser will open with adblock — press each page's
   download button"), then `catchUserDownloads` over the best-ranked link per
   file. Only ask once per whole update run, not per link.
5. `DirectDownloadFile` gains `headers?: Record<string, string>`; resolved
   files keep the `update{groupIndex}-` name prefix so
   `installUpdateGroups` grouping is untouched.

The `request-dl` FileCrypt initial-install branch gets the same treatment
(shared helper), killing its twin `did not contain supported FuckingFast
links` throw.

### 3. Dependency

Add `puppeteer-extra-plugin-adblocker` (pulls `@ghostery/adblocker-puppeteer`).
The user considers adblock non-negotiable for these hosters; the plugin is the
same one steamrip uses, filter lists are fetched once and disk-cached
(`useCache: true`).

## Risks / open questions

- **One-shot or IP/session-locked download tokens.** Catch-then-cancel means
  OGI re-requests the URL seconds later. steamrip runs this exact pattern in
  production successfully; carrying cookies + Referer in `headers` covers the
  session-locked case. A hoster with strictly single-use tokens would need the
  addon to *not* cancel and instead let Chrome finish the download — deferred
  until a real hoster proves the need.
- **Click fatigue.** A game with 4 updates × 2 files each = 8 clicks. The
  batch browser + upfront single notice keeps it tolerable; FuckingFast links,
  when present, still short-circuit to zero clicks.
- **Filename trust.** `suggestedFilename` comes from the hoster; sanitize it
  (strip path separators) before using it as `DirectDownloadFile.name`.
- **Headless environments.** The interactive path requires a display, same as
  the existing `catchDownload` (already `headless: false`), so this is not a
  regression.

## Scope estimate

- `src/download-catcher.ts` — new, ~150–200 lines (catcher + popup handling +
  header capture).
- `src/main.ts` — rework of the two FuckingFast-only filters into a shared
  resolve-links helper, ~60 lines net.
- `src/direct-download.ts` — add `headers?` to `DirectDownloadFile`.
- `package.json` — one new dependency.
- Tests: the catcher is browser-bound (skip); a small unit test on the
  rank-and-route decision (FuckingFast fast path vs interactive fallback) is
  worthwhile.

# Recipe Import Sheet and Social Import Plan

Created: 2026-06-17
Status: planned

## Goal

Make recipe creation feel calmer and clearer in iOS by separating manual entry from
import flows, then extend import support from ordinary recipe pages to social recipe
links where the platform allows enough metadata.

The product promise should stay modest: imports create a draft for review. Veckly should
not pretend that every TikTok, Reel, or social post can be converted into a complete
recipe without user correction.

## Current Baseline

- Backend already has `POST /recipes/import-from-url`.
- Backend URL import already handles URL validation, SSRF protection, schema.org recipe
  parsing, AI fallback, user rate limiting, and returns an `ImportedRecipe`.
- Backend URL import now exposes stable `RecipeImportError` response bodies in OpenAPI.
- Recipes already persist `source_url` and `source = 'url_import'`.
- iOS `RecipeFormSheet` now separates create mode into `Write` and `Import`.
- iOS maps import error codes to specific user-facing copy and shows the source URL after
  an import succeeds.
- iOS `RecipeStore` already exposes `importFromURL(_:)`.

## Status Summary

| Phase | Title | Status |
|---|---|---|
| 0 | Product and technical decision | Complete |
| 1 | Split iOS sheet into Write / Import | Complete |
| 2 | Harden ordinary URL import UX | Complete |
| 3 | Text / caption draft import | Not started |
| 4 | Backend social metadata extraction | Not started |
| 5 | Social draft generation and warnings | Not started |
| 6 | Persist optional import provenance | Deferred |
| 7 | Instagram/Reels deeper integration | Deferred |

## Phase 0 - Product and Technical Decision

**Status:** Complete

### Decision

Use a segmented/tabs pattern in the recipe sheet:

- `Write`: manual recipe entry.
- `Import`: paste a recipe page URL, generate a draft, then review/edit.

Social import is best-effort:

- TikTok can be supported first through official oEmbed metadata: title/caption,
  author, thumbnail, provider, and embed HTML. This is enough for a draft prompt, but
  not a structured recipe by itself.
- Instagram/Reels should not be promised as full automatic import in the first slice.
  Treat it as "paste a link or caption" until we have approved platform access and a
  reliable source of caption/transcript data.

### Non-goals

- No video downloading.
- No scraping private or login-only content.
- No automatic save after import.
- No unofficial platform API dependency in the first production slice.
- No guarantee that social links produce complete ingredients and steps.
- Imported recipes remain household-private in the first version. Public/community
  publishing for imported social recipes is out of scope until attribution and rights
  rules are explicit.

## Phase 1 - Split iOS Sheet into Write / Import

**Status:** Complete (2026-06-17)

### iOS

- Replace the top-level `Import from URL` section in `RecipeFormSheet` with a segmented
  control, probably `Picker("Mode", selection: ...)` using `.segmented`.
- Modes:
  - `Write`: current form sections only.
  - `Import`: URL import surface first. After import succeeds, switch back to `Write`
    with the generated draft filled in for review.
- Keep `Save` disabled until the draft has a non-empty normalized title.
- Keep unsaved-change confirmation.
- Keep import as create-only; edit mode opens directly in `Write`.

### Backend

- No backend change.

### DB

- No DB change.

### Tests

- `RecipeFormSheet`/store-level coverage if view tests are practical:
  - create mode defaults to `Write`;
  - switching to `Import` does not erase an existing draft without confirmation;
  - successful import fills the draft and moves the user into review/edit state.
- `xcodebuild build-for-testing`.

### Acceptance

- Manual recipe creation no longer shows import controls unless the user chooses import.
- A pasted ordinary recipe URL still produces the same draft as today.

## Phase 2 - Harden Ordinary URL Import UX

**Status:** Complete (2026-06-17)

### iOS

- In `Import`, use copy that sets expectations:
  - field placeholder: `Recipe page URL`
  - button: `Create draft`
  - post-import hint: `Review before saving`
- Show source URL after import so the user can verify what was used.
- Add clear failure states:
  - invalid URL;
  - cannot access page;
  - could not find enough recipe detail;
  - rate limited.
- Keep the imported result as a draft until the user taps `Save`.

### Backend

- Keep the existing `POST /recipes/import-from-url` endpoint.
- Normalize error codes if they are not already stable enough for iOS:
  - `INVALID_URL`
  - `UNSUPPORTED_URL`
  - `FETCH_FAILED`
  - `NO_RECIPE_FOUND`
  - `RATE_LIMITED`
  - `IMPORT_FAILED`
- Return enough structured response metadata for iOS to decide whether to show a warning.
  Suggested additive shape:

```ts
{
  recipe: ImportedRecipe
  warnings?: string[]
  confidence?: 'high' | 'medium' | 'low'
}
```

### DB

- No DB change required. Persisted recipes already store:
  - `source = 'url_import'`
  - `source_url = <original URL>`

### Tests

- Backend tests for stable error mapping.
- OpenAPI tests/snapshot should include stable error-code response shapes.
- iOS tests for import failure messages and draft preservation.

### Acceptance

- Ordinary recipe pages still work.
- Failed imports are understandable and do not destroy manually typed draft content.

## Phase 3 - Text / Caption Draft Import

**Status:** Not started

This should come before platform-specific Instagram work. It covers the practical user
case where a recipe exists as a caption, message, note, or copied social text.

### Backend

- Add a new authenticated endpoint, likely `POST /recipes/import-from-text`.
- Request:

```ts
{
  text: string
  sourceUrl?: string
  sourceLabel?: string
}
```

- Response mirrors URL import:

```ts
{
  recipe: ImportedRecipe
  warnings?: string[]
  confidence?: 'high' | 'medium' | 'low'
}
```

- Add a separate rate limit from URL import because text import will almost always use AI.
- Add OpenAPI schemas for request, success, and stable error codes.
- Prompt should leave missing amounts blank unless they are strongly implied.

### DB

- No DB migration. Saved recipes can still use `source = 'url_import'` when `sourceUrl`
  exists, otherwise `source = 'ai_generated'` or `user_created` depending on final naming.
- Revisit source enum naming before implementation; `text_import` may be worth adding if
  analytics need to distinguish this flow.

### iOS

- Extend the `Import` tab with a second mode: `Link` / `Text`.
- `Link`: calls existing `importFromURL`.
- `Text`: calls new text import endpoint through `RecipeStore`.
- Successful text import switches to `Write` with a draft filled in.

### Tests

- Backend: validates input length, rate limit, AI response mapping, stable error codes.
- iOS: text import fills draft and keeps review-before-save behavior.

### Acceptance

- A user can paste an Instagram caption, text message, or note and get an editable recipe
  draft without any Instagram API integration.

## Phase 4 - Backend Social Metadata Extraction

**Status:** Not started

### Backend

Add a social-aware extraction layer before the existing general HTML import path:

1. Classify URL host:
   - `tiktok.com`
   - `vm.tiktok.com`
   - `instagram.com`
   - other/general web
2. TikTok:
   - Resolve short links safely through the existing URL safety guard.
   - Enforce max redirect hops, timeout, DNS/private-IP checks after redirects, and
     final-host allowlisting.
   - Call TikTok oEmbed for public videos.
   - Extract visible title/description text when available, author name, author URL,
     thumbnail URL, provider name, canonical video URL.
   - Do not store or proxy video media.
3. Instagram:
   - First slice: classify and return a controlled `UNSUPPORTED_SOCIAL_SOURCE` or
     `CAPTION_REQUIRED` response unless ordinary page metadata gives enough public text.
   - Do not rely on brittle scraping.
4. General web:
   - Continue current schema.org + AI fallback.

Suggested internal type:

```ts
type TImportSourceMetadata = {
  platform: 'web' | 'tiktok' | 'instagram'
  canonicalUrl: string
  title?: string
  description?: string
  authorName?: string
  authorUrl?: string
  thumbnailUrl?: string
  rawTextForDraft?: string
}
```

### DB

- No migration in this phase. Metadata can stay request-local until we decide what should
  be visible after save.

### iOS

- No UI change beyond using new response warnings/error codes.

### Tests

- Unit tests for host classification.
- Unit tests for TikTok oEmbed success and failure using mocked fetch.
- SSRF tests must still pass for redirects and short links, including private-IP redirect
  attempts and excessive redirect hops.
- Ensure Instagram private/login-required links produce a controlled error.

### Acceptance

- TikTok public video links produce source metadata without fetching video bytes.
- Instagram links fail gracefully with copy that suggests pasting the caption/manual entry.

## Phase 5 - Social Draft Generation and Warnings

**Status:** Not started

### Backend

- Feed social metadata into the existing AI extraction path with a social-specific prompt.
- Prompt principle:
  - infer only what is supported by caption/title/visible text;
  - leave missing quantities blank rather than inventing precise values;
  - produce a practical household recipe draft when enough text exists;
  - include warnings when the source is too thin.
- Response should make uncertainty visible:

```ts
{
  recipe: ImportedRecipe
  source: {
    kind: 'web' | 'tiktok' | 'instagram'
    url: string
    title?: string
    authorName?: string
    thumbnailUrl?: string
  }
  warnings: string[]
  confidence: 'high' | 'medium' | 'low'
}
```

### DB

- No DB change required if warnings/confidence are only review-time state.
- Saved recipe still persists as a normal household recipe with `source = 'url_import'`
  and `source_url`.
- Minimal platform display can be derived from `source_url` at read time. Do not add DB
  provenance until the product needs durable attribution beyond the URL.

### iOS

- Show platform-aware import review:
  - `Imported from TikTok` or `Imported from web`.
  - Show warning banner for low-confidence drafts.
  - Keep user in edit/review mode before save.
- For Instagram unsupported/caption-required:
  - show an inline fallback: paste caption/text manually;
  - optionally pass pasted text to a new text-based draft endpoint in a later slice.

### Tests

- Backend: social metadata + AI mocked response maps into `ImportedRecipe`.
- iOS: low-confidence warning appears and save still requires title.
- iOS: Instagram unsupported state offers manual fallback instead of generic error.

### Acceptance

- TikTok links can create a reasonable draft when captions contain enough recipe detail.
- Low-confidence imports are visibly labeled as drafts that need review.

## Phase 6 - Persist Optional Import Provenance

**Status:** Deferred

Do this only if we want saved recipes to display their import source beyond the source URL.

### Backend / DB

Option A: add nullable columns on `recipes`:

- `source_platform text`
- `source_title text`
- `source_author_name text`
- `source_thumbnail_url text`

Option B: add a separate `recipe_imports` table:

- `id`
- `recipe_id`
- `household_id`
- `source_platform`
- `source_url`
- `source_title`
- `source_author_name`
- `source_thumbnail_url`
- `confidence`
- `warnings`
- `created_at`

Prefer Option A unless we need an audit trail. The product only needs lightweight
attribution in the recipe detail view.

### iOS

- Display compact source attribution in `RecipeDetailView`.
- Do not show social thumbnails as primary recipe imagery unless we have explicit rights
  and stable URLs.

### Tests

- Migration test / schema snapshot.
- Create/update/read recipe includes provenance fields.
- iOS decoder tolerates missing provenance.

## Phase 7 - Instagram/Reels Deeper Integration

**Status:** Deferred

This should wait until there is a real product need. Instagram/Meta integration may require
app review, access tokens, business account constraints, and permissions that are not worth
blocking the first import UX on.

### Possible Future Paths

- Official Meta oEmbed / Graph API integration if approved and stable for the intended
  content type.
- User-provided caption import: user pastes the Reel caption/text; Veckly creates a draft
  from text without fetching platform data.
- Share extension: user shares text/link into Veckly; app opens the import tab prefilled.

### Acceptance for Taking This Up

- At least a few beta users try to import Instagram/Reels recipes and fail.
- We know whether they expect caption import, video transcription, or simply link storage.
- We have a supportable official API path or choose a caption-only UX deliberately.

## Open Questions

- Should AI leave missing ingredient amounts blank, or should it add approximate amounts
  with a warning? Current recommendation: leave blank unless strongly implied.
- Do we want a Share Extension later so users can share from Safari/TikTok/Instagram into
  Veckly directly?

## Recommended Execution Order

1. Phase 1: iOS split into `Write` / `Import`.
2. Phase 2: clearer ordinary URL import errors and draft review UX.
3. Phase 3: text/caption draft import.
4. Phase 4: TikTok oEmbed metadata extraction in backend.
5. Phase 5: TikTok/social draft generation with warnings.
6. Reassess user demand before Phase 6 or 7.

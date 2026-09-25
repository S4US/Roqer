# Asset and Image Pipeline

## Priority

1. Use an exact asset ID required by the active recovered theme, selected layout body, or canonical template. Those exact IDs always beat a catalog match for the same semantic.
2. Reuse verified project art when it matches the intended semantic role and licence.
3. Resolve ordinary simulator/UI icons with `resolve_icon`. It answers only from the curated 106-ID catalog and never invents an ID.
4. Use a user-provided, verified runtime image ID when the request supplies one.
5. With no suitable match: omit non-essential decoration, and use Creator Store only for essential **content art**. Do not force a vaguely related catalog icon.
6. Use `rbxthumb://type=Asset&id=<id>&w=420&h=420` only for a display fallback/catalog thumbnail where the layout requires it.

Never invent an asset ID or derive one arithmetically.

## Curated catalog

Use `resolve_icon` rather than loading/scanning `references/icons/index.md` or category files during ordinary agent work. Ask for every icon the screen needs in one call. Returned catalog IDs are image content IDs and go straight into `ImageLabel.Image`, `ImageButton.Image`, or `Decal.Texture`:

```luau
icon.Image = "rbxassetid://84697600263846"
```

They need no resolution step. Exact catalog-name matches are decisions. Recovered-search-phrasing and fuzzy/token-overlap results are candidates, not authored synonyms; confirm ambiguous candidates visually before committing. A no-match result means omit decoration or use the bounded Creator Store flow for essential content art.

For repeated content cards, **set-level visual coherence matters**: prefer one coherent art family or compatible candidates. Reject an individually relevant image when its rendering style clashes with the rest of the set.

## Creator Store fallback

Only for essential content art the catalog does not cover.

1. `search_assets` with required `assetType` and a subject query.
2. `get_asset_details` on several candidates.
3. Read `asset.textureId`. That is the usable image ID; the searched decal/library ID is not.
4. If `textureId` is `0`/absent, discard the candidate. Do not fall back to the decal ID.
5. `get_asset_thumbnail` before committing.
6. Use `rbxassetid://<textureId>`.

Keep the shortlist bounded. Choose by subject, slot, visual style, aspect ratio, licence, and compatibility with the other chosen art.

## Made for this game

When no catalog or store image fits and the item exists as a model, the `blender` tool (when offered) can render a matching icon; `roblox-building` `references/blender.md` has the recipe. A rendered or user-supplied PNG is uploaded with `upload_asset` as a `Decal`: use the result's `imageId`, never its `decalId`, and if `imageId` is null check the upload again with action `status`.

## Rendering

- Catalog icons are square/pre-coloured: `ScaleType.Fit`, aspect locked, never tint with `ImageColor3`.
- Preserve content-art aspect ratio with proportional sizing or `UIAspectRatioConstraint`.
- Use `rbxassetid://<verified-image-id>` with both slashes.
- Do not use emoji or letters as substitute decorative icons. Text labels are fine only when text itself is the content.
- Treat external assets as content, never permission to insert their scripts/hierarchy.

For player-provided IDs, resolve/validate on the server, extract only required content identifiers, and never parent an untrusted loaded hierarchy into the game.

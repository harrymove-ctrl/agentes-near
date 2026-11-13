# 0166. A person's pixel portrait

- Status: Accepted (the web app; the phone app shows the portrait as a photo and builds none yet)
- Date: 2026-11-10
- Extends: the profile photo (`PUT …/me/avatar`)

## Context

A person shows as a photo or as initials. Many people never send a photo, so a workspace is mostly initials next to
agents that each have a face. The product's look is pixel and dither (the agents, the sky), and a person had no way to
have a face in it without a camera.

## Decision

### 1. A portrait is a recipe

`packages/ui/src/person/engine.js` (plain JavaScript with `engine.d.ts`, like the agent engine) draws a person on a
32×32 grid from a recipe: build, skin, hair and its color, beard, glasses, what goes on the head, earrings, what goes
around the neck, lipstick, eyeshadow, blush, a mark, eye color, clothes and their color, mood, and a background in one
of the agents' eight colors, dithered like the sky. Every piece is a mask of rows painted in order with its own
outline, so any piece fits any other. `FIELDS` names every field and its values, in the order of the recipe's code:
`encodeRecipe` writes `1.` and the values between dots, `decodeRecipe` reads it, falling back to the default for a
value it does not know and ignoring fields a newer code adds.

Small faces (up to 48 px) show the face alone, 24 cells; larger ones the whole bust (`cropFor`). `PersonPortrait`
draws on a canvas with a whole number of device pixels per cell.

### 2. The portrait is the person's photo, with its recipe on the address

No new column and no new field on every payload that carries a person. The builder sends the portrait as a 512×512
PNG through the photo's own route with `portrait`, the recipe's code; the server checks its shape
(`PORTRAIT_CODE`) and stores the photo's address with the code after it as a fragment:
`/api/app/avatars/{userId}/{file}.png#px=1.f.s3.…`. A fragment is never sent in a request, so the file is fetched as
before and everything that shows a photo (the phone app, a push, an email) shows the portrait as an image. `Avatar`
reads the fragment (`recipeOfUrl`) and draws the portrait itself where there is a canvas, crisp at its size and with
the face framed on small tiles; the builder reads it to open on the portrait the person has. Sending a photo, or
removing it, replaces the address and with it the recipe.

Someone who never built a portrait keeps their initials: no portrait is made up for them.

### 3. The builder

"Change photo" in the profile first asks how the person wants to appear (`AvatarChoiceDialog`): two doors side by
side, "Build an avatar" with pixel faces taking turns on it and "Upload a photo" with the person's own tile.
`AvatarBuilderDialog` (`apps/web/src/components/AvatarBuilder.tsx`) opens from the first; the photo is still one link
away in its footer. The portrait stands on the left with a Masculine / Feminine switch, Shuffle and
the small sizes; the pieces are in tabs on the right. Every option is a tile showing the person's own portrait wearing
it, and pointing at one tries it on the large portrait.

The switch chooses what is offered, not only how the face is drawn: `CATALOG` lists each build's cuts, clothes,
earrings and what goes around the neck and on the head; Beard is a tab of the masculine build and lipstick and
eyeshadow of the feminine one (the tab is Marks on the other). Changing build changes the whole portrait and remembers
the one left on each side, carrying skin, eyes, hair color, mood and background across. Each side starts plain, with
nothing on. "Show every option" lists everything on either build, and an option the person already wears is never
left out of a list.

## Consequences

- A portrait costs one small PNG in the platform bucket, like a photo, and no migration.
- The phone app shows portraits (as images, the bust at every size) but cannot build one yet.
- A client that rewrites the photo's address without the fragment loses the recipe, not the picture: the builder then
  opens on the plain start.

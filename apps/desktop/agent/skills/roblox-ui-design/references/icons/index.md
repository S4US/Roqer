# Curated Icon Catalog — index

106 verified Roblox **image content IDs** in one consistent style: square,
pre-coloured, heavy navy outline, saturated two-stop gradients. They are the
house art for the SIM theme and work anywhere that theme's identity fits.

## Using an ID

These are image content IDs, not Decal wrapper IDs. Use one verbatim:

```luau
icon.Image = "rbxassetid://84697600263846"
```

Valid in `ImageLabel.Image`, `ImageButton.Image`, and `Decal.Texture`.

- Do **not** run a catalog ID through the decal-to-image resolution flow in
  [assets](../core/assets.md). That step is only for IDs obtained from Creator
  Store search, the Toolbox, or a library URL.
- Use `ScaleType.Fit` and preserve the square aspect.
- Never tint one with `ImageColor3`. They are already coloured.

## Choosing one

1. An exact asset ID named by the active theme or layout always wins over a
   catalog icon for the same semantic.
2. Otherwise take the catalog match.
3. With no suitable match: omit non-essential decoration, and use Creator Store
   search only for essential content art. Do not force a vaguely related catalog
   icon to avoid searching.

Coverage is strong for ordinary simulator UI — currency, shop and navigation
chrome, progression, rewards, pets, player and status. The gap is **content
art**: specific pets beyond dog/cat/bunny, particular shop products, unusual
weapons, environment and background art, game-specific objects.

The names below are the semantic slot an icon fills, not a literal description
of what is drawn. When a name is close but you want to confirm the picture
before committing, `get_asset_thumbnail` returns one you can look at.

If no name here reads as a match, load the category file for the nearest
category — those carry the search phrasings each icon was found under, which
often connect a concept to a slot the name alone does not suggest.

## Animal — [aliases](animal.md)

| Name | ID |
|---|---|
| Bunny | `rbxassetid://97628616133746` |
| Cat | `rbxassetid://136373929646470` |
| Dog | `rbxassetid://94785235613863` |

## Currency — [aliases](currency.md)

| Name | ID |
|---|---|
| Cash | `rbxassetid://70565105539676` |
| Coin | `rbxassetid://84697600263846` |
| Crystal | `rbxassetid://73150429062000` |
| Diamond | `rbxassetid://75581768563141` |
| Ingot | `rbxassetid://83606937519307` |
| Premium | `rbxassetid://78918235954057` |
| Ticket | `rbxassetid://123370754779214` |
| Robux | `rbxassetid://87608142780557` |

## Exclusive — [aliases](exclusive.md)

| Name | ID |
|---|---|
| Angel Heart | `rbxassetid://77354444720914` |
| Magical Teleport | `rbxassetid://125856842589066` |
| Tung | `rbxassetid://98107998829029` |
| VIP | `rbxassetid://97092630460629` |

## Food — [aliases](food.md)

| Name | ID |
|---|---|
| Burger | `rbxassetid://131831653905006` |
| Cookie | `rbxassetid://92727662543456` |
| Pizza | `rbxassetid://118662104704624` |

## Item — [aliases](item.md)

| Name | ID |
|---|---|
| Axe | `rbxassetid://75127143522091` |
| Backpack | `rbxassetid://118915534669949` |
| Balloon | `rbxassetid://86067946513885` |
| Bomb | `rbxassetid://96872034340553` |
| Book | `rbxassetid://117316658726625` |
| Box | `rbxassetid://99990137483704` |
| Bubble Gum | `rbxassetid://119328274787822` |
| Calendar | `rbxassetid://108944239950574` |
| Chest | `rbxassetid://76137715921998` |
| Clock | `rbxassetid://109014091086075` |
| Coil | `rbxassetid://121041765810680` |
| Credit Card | `rbxassetid://72685970590604` |
| Crown | `rbxassetid://78843852703854` |
| Dice | `rbxassetid://125278872428987` |
| Egg | `rbxassetid://113316632422703` |
| Gift | `rbxassetid://122416766679510` |
| Hammer | `rbxassetid://95064026158349` |
| Key | `rbxassetid://96066489256923` |
| Location Pin | `rbxassetid://108187453204701` |
| Lock | `rbxassetid://113981661296218` |
| Lucky Block | `rbxassetid://115410948249385` |
| Magnet | `rbxassetid://113237606120555` |
| Medal | `rbxassetid://136770365348318` |
| Newspaper | `rbxassetid://106567385913035` |
| Pencil | `rbxassetid://84252310370894` |
| Potion | `rbxassetid://71202349341308` |
| Rocket | `rbxassetid://93379001930135` |
| Scroll | `rbxassetid://76733867334368` |
| Shield | `rbxassetid://93114601642790` |
| Shoe | `rbxassetid://100402338773449` |
| Shovel | `rbxassetid://84998465111718` |
| Sword | `rbxassetid://94091032987086` |
| Target | `rbxassetid://120517988406723` |
| Teleporter | `rbxassetid://121913397438916` |
| Torch | `rbxassetid://121599159289303` |
| Trophy | `rbxassetid://77830885604568` |

## Main — [aliases](main.md)

| Name | ID |
|---|---|
| Broken Heart | `rbxassetid://112993477288479` |
| Codes | `rbxassetid://83034712079665` |
| Fire | `rbxassetid://73214946386499` |
| Heart | `rbxassetid://133958322179641` |
| House | `rbxassetid://101953044632807` |
| Lighting | `rbxassetid://91519647625054` |
| Magnifying Glass | `rbxassetid://124585991248748` |
| Music ON | `rbxassetid://136121323044955` |
| Paw | `rbxassetid://88750231673471` |
| Rebirth and Auto Open | `rbxassetid://80234316052758` |
| Save | `rbxassetid://128628918523248` |
| Settings | `rbxassetid://119570973950437` |
| Shopping Bag | `rbxassetid://120628031716892` |
| Shopping Cart | `rbxassetid://123838677183783` |
| Sound OFF | `rbxassetid://130491537894606` |
| Sound ON | `rbxassetid://78863931900480` |
| Star | `rbxassetid://112684829478873` |
| Stats | `rbxassetid://92574857197960` |
| Trade | `rbxassetid://71704954911252` |
| Trash Can | `rbxassetid://72745454842879` |
| Upgrade | `rbxassetid://124300905660565` |
| Verify | `rbxassetid://104406265234482` |
| Wheel | `rbxassetid://120233256572525` |

## Nature — [aliases](nature.md)

| Name | ID |
|---|---|
| Apple | `rbxassetid://120786616810420` |
| Banana | `rbxassetid://126823412198932` |
| Cloud | `rbxassetid://104293709713395` |
| Leaf | `rbxassetid://122842695290895` |
| Orange | `rbxassetid://90219705854308` |
| Planet | `rbxassetid://126361365802334` |
| Strawberry | `rbxassetid://74842913450679` |
| Thunderstorm | `rbxassetid://72607541698873` |
| Wheat | `rbxassetid://117191338665794` |

## Player — [aliases](player.md)

| Name | ID |
|---|---|
| 4 Players | `rbxassetid://135436588486118` |
| Add Player | `rbxassetid://121328279027494` |
| Arm | `rbxassetid://134595823778256` |
| Friend | `rbxassetid://87070401810152` |
| Full Body | `rbxassetid://89448335631573` |
| Player | `rbxassetid://99097554161865` |
| RIP | `rbxassetid://78429385384235` |
| Skull | `rbxassetid://126528254643859` |
| Smiling Face With Horns | `rbxassetid://111585498610164` |

## Social — [aliases](social.md)

| Name | ID |
|---|---|
| Twitter | `rbxassetid://95030464833532` |

## UI — [aliases](ui.md)

| Name | ID |
|---|---|
| Chat | `rbxassetid://94298126681415` |
| Checkmark | `rbxassetid://128850290702187` |
| Cursor | `rbxassetid://83339102562613` |
| Exclamation Mark | `rbxassetid://99848348794456` |
| Info | `rbxassetid://119677199991519` |
| Minus | `rbxassetid://115333097448632` |
| Plus | `rbxassetid://127726919558379` |
| Question Mark | `rbxassetid://80027380832882` |
| Skip | `rbxassetid://75745436562174` |
| Warning | `rbxassetid://122437442880819` |
| X | `rbxassetid://138478881597994` |

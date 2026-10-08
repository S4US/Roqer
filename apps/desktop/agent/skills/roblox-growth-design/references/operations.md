# Roblox Growth Design: Operations and Audit

Continues [full.md](full.md) §1–§5; sources are listed there.

## 6. Packaging and Metadata

### Official requirements and behavior

Use accurate, original metadata. Roblox can reduce exposure for:

- giveaway-led metadata;
- mismatched metadata and gameplay;
- non-unique games with metadata and place files closely resembling existing games.

Quality status is reclassified with updates. Reduced-exposure experiences receive a Creator Dashboard banner that updates daily.

Icons should be square and at least 512×512. Thumbnails should be 16:9 and ideally 1920×1080. Preview both at small mobile sizes. Keep essential details away from areas Roblox overlays with metadata.

### Thumbnail personalization

For Home personalization:

1. Activate 2–5 accurate thumbnails.
2. Roblox initially explores them across users, then allocates more impressions to winners by segment while retaining exploration traffic.
3. Inspect impressions, qualified plays, average playtime, QPTR, and winning segment.
4. Keep multiple thumbnails active so personalization can adapt.
5. Test new thumbnails around a major game or content update, then avoid changing them again until the next update.

QPTR here means qualified plays divided by Home recommendation impressions. The broader Discovery signal table separately calls its top conversion signal **play through rate**. Do not silently treat every dashboard's denominator or qualification rules as identical.

### Creative choices

Use these as starting points, not ranking rules:

- communicate one dominant fantasy or action;
- prioritize subject, action, emotion, and contrast over clutter;
- make the image understandable at actual display size;
- use honest in-game content and visual fidelity;
- avoid tiny text and UI-like thumbnail layouts;
- use title wording for searchable clarity and differentiation, not keyword stuffing;
- test whether the package attracts players who actually enjoy the first session.

**Design specifics:**
- Simple backgrounds. Clutter kills CTR.
- 1–2 characters (3 only if the composition demands it; more is visual noise).
- High color contrast: bright subjects popping off the background (yellow character on clear blue sky).
- Exaggerated, instantly readable emotions: manic evil smile, crying/stressed face, troll face.
- Tease a mechanic over the title: text like "Steal at Night" or "Cure the Survivors" gives context and intrigue; the game's name alone usually does not.

**Thumbnail formats:**
1. **Before & after:** noob vs. pro, cheap vs. expensive split. Works for tycoons and progression games.
2. **First-person perspective:** viewer inside the action. Works for PVP, shooters, RP.
3. **Two-character scene:** conflict or interaction, someone getting outplayed.
4. **One character + action:** maximally readable and simple.
5. **Entirely new concept:** unique to your game's mechanic; highest risk, highest differentiation.

**Creation workflow:**
1. Research genre tropes in top games of the niche (e.g., hacker games: masks, green binary, brand rivalries).
2. Rough mockup in a free tool (basic shapes, clip art, text) to fix the layout before committing to detail.
3. Generate or commission from the mockup with a highly specific scene prompt.
4. Iterate with explicit direction ("remove the clouds", "make text larger", "flip the character").
5. Simplify for mobile first. Detailed desktop thumbnails are often unreadable on phones.

**Testing:** A/B test 2–3 thumbnails per week. CTR naturally decays as impressions accumulate, so keep rotating fresh, readable thumbnails. Test around major game or content updates, then let the winner stabilize.

Optional tools:

- [qptr.io](https://qptr.io) previews an icon or thumbnail beside simulated neighbors. It does not measure live Roblox performance.
- [Creator Exchange](https://creatorexchange.io) offers directional market and game estimates. It is not an official Roblox analytics source.

## 7. Monetization With Trust

Good monetization exposes clear value to willing players while the free core remains enjoyable.

Design principles:

- transparent storefront and purchase result;
- several price points and a mix of durable and consumable value;
- no hard-coded Robux prices when Managed Pricing can change them;
- regional pricing where appropriate;
- no deceptive odds, false urgency, disguised purchase buttons, repeated interruption, or punishment for declining;
- no sale that corrupts competitive integrity unless the game's promise clearly supports it;
- server-authoritative granting and idempotent receipt handling.

Price optimization requires enough transactions for statistically useful data. Roblox says it usually needs at least 60,000 transactions over the preceding 30 days. Smaller games should use qualitative value research and carefully scoped experiments rather than pretending a tiny sample proves an optimal price.

When the economy or monetization health is in question, load `roblox-analytics` for the telemetry-first decision layer: sink/source ratio, inflation, whale concentration, and the diagnose-with-telemetry workflow. Telemetry tells you what broke; the design fix is yours.

Cross-reference `roblox-monetization`, `roblox-security`, and `roblox-data` before implementing purchases.

### Monetization: product design

A live-game operator's playbook for dev products, from a game that grew revenue ~3x on the same player base.

**Data first, then hypothesize.** Before touching products, sort dev product sales descending and identify the best seller. Form a hypothesis for the next product from data and observed behavior, ship it, check results (revenue AND side effects), keep or revert. Do not design products on instinct.

**Watch live play, not just numbers.** Your game won't always be played as intended: operators found players running an active game AFK (and getting robbed in PvP), which surfaced a real friction point. Combine dashboard data with observation and player feedback (Creator Dashboard > audience feedback) to find the pains worth solving.

**Convert valuable game passes into consumables.** 2x offline earnings, 2x cash, and similar high-value boosts are usually implemented as one-time game passes, but that caps the **7-day spend days per user** stat (number of unique days in 7 days a user spends Robux in your experience). Consumables (repeat-purchase dev products, like consumer packaged goods: toothpaste, supplements) pump that stat: players buy a 24-hour lock today, tomorrow, the next day. A consumable that solves a real friction point almost always becomes the top seller. Experiment with consumables aggressively.

**Products should be must-haves that solve a pain, not nice-to-haves.** Best sellers are pain-relievers:
- effort grind → buy speed/cash (pain of effort);
- losing progress while AFK → base lock / protection (pain of safety);
- fear of missing out → 2x offline earnings (pain of missing out on gains);
- status/looks → limited-stock cosmetics (pain of "looking like a casual"). Limiteds with real scarcity (only 100 for sale) outsell unlimited cosmetics.

**Place products at points of interest (POI), not just in the HUD.** Put physical dev products where foot traffic is highest (e.g., at the base entrance the player walks through constantly). Swap the paid product with the free one so the paid version sits at the highest-traffic spot. In addition: time the prompt at the decision moment (offer 2x offline earnings right when the player walks over the collect point; cheap 19-Robux upsell).

**Improve purchase pathways.** Multiple ways to reach the shop increase sales: HUD shop icon, a "+" cash button next to the currency display, and (after 3 failed buy attempts) an automatic cash-shop popup. First two "not enough money" errors show a soft error; on the third, open the shop. Keep the popup non-intrusive (cap per session). UI and physical in-world pickups both count as pathways.

**Check for collateral damage.** After shipping a product, check it didn't wreck other stats: playtime, D1, D7, session time, first-time user experience, and the in-game economy (over-priced currency or 2x boosts can destroy progression balance). Economy-destroying prices (e.g., $1B cash for 9 Robux) cook the game long-term.

## 8. Social Design and LiveOps

Social features are not automatically retention features. Define the interaction:

- collaboration, competition, spectatorship, gifting, trading, parties, guilds, or shared creation;
- how solo and new players avoid exclusion;
- moderation and abuse controls;
- scam-resistant trade and gift flows, reporting, and escalation;
- mandatory filtering for player-authored text and the review burden of uploaded content;
- griefing controls that preserve legitimate competition;
- whether server size and matchmaking support the intended behavior;
- how co-play is measured without manufacturing friction.

### 8.1 LiveOps taxonomy (official)

LiveOps is the post-launch support that maintains engagement. Four update types, in increasing scope:

1. **Content cadence**: regular release of fresh content (weekly to monthly), building on existing systems: limited-time events, seasonal content, UGC. Cheap to produce, maintains engagement between major updates, concentrates programming resources on the next major.
2. **Major updates**: new or expanded systems that change gameplay: social systems (guilds, trading), competitive systems (PVP, leaderboards, tournaments), collections/achievements, large live events aimed at re-engaging lapsed players. Months of development; retain existing players and attract new ones.
3. **Quality-of-life improvements**: polish: UI layouts, UX flows, aesthetic refreshes, accessibility, performance. Can have outsized goodwill impact; gather player feedback on frustrations and time sinks.
4. **Bug fixes**: implementation issues. Prioritize by severity (impact on gameplay), effort, and number of players affected.

Blend all four; cadence keeps the game fresh, majors evolve it, QoL buys goodwill, bug fixes preserve trust. The precise cadence depends on the team's capability and the game's systems; balance player desires against what can be reliably delivered.

**Content cadence sustainability (official).** Keep cadence releases cheap and maintainable:

- **Choose correct content**: items, furniture, pets, vehicles, weapons, maps, quests are predominantly art-based, requiring little programming or design. Simple variants (color changes) are ideal. Themed releases (seasonal, holiday, around a central concept) unlock cross-item creativity. Use analytics and player feedback to target high-value content.
- **Manage scope**: spend under three weeks of effort per cadence release so the schedule stays rapid and leaves room for other LiveOps. Adding new systems to support a release turns cadence into an expansion and becomes unsustainable.
- **Establish a routine**: a regular cadence (common: every two weeks to a month) makes players check back and anticipate releases; it also makes the team more efficient with practice.
- **Prioritize sustainability**: content should not be immediately consumable by most players, or the team is forced to over-release. Deliver sustainably through: progression (add permanent content near endgame where veterans run out of objectives), limited-time content (available to all for an event; earn via quests/milestones/event currency, balanced so it takes most players weeks to exhaust), and season passes (the standard delivery vehicle: quest-based, with free and premium tiers).

### 8.2 Planning (official)

- **KPIs**: pick the metric you want to impact (e.g. daily active users) before designing the update. Events usually move several KPIs at once.
- **Player actions**: define the intended player actions during the event and the KPIs those actions influence.
- **Economy impact**: increased interaction can change earning/spending patterns. Design rewards so they don't damage the economy (e.g. a fishing tournament that exposes a currency-earning loop must not hand out rewards that break price levels).
- **Communication**: plan external (social, community) and internal (popups, UI, lobby) communication, and its timing. Advance notice lets players schedule their return; waiting too long risks being overlooked.
- **Monitor and analyze**: track currency sources/sinks; make data timely (hourly or same-day checks during launch), comparable (compare event weeks to pre/post event weeks), and use it to confirm the event is hitting goals without granting too much.

### 8.3 Applying the cadence

From an operator with a live 21K CCU game (~$131K/mo):

- **Patch vs update track**: patches (bugs, exploits, nerfs/buffs, monetization tweaks) ship daily if needed; never wait for a weekly window. Updates ship weekly/bi-weekly and each names its metric before work starts.
- **Three data sources**: qualitative (Discord bug reports, community forum, Creator Dashboard Feedback tab AI summary), quantitative (dashboard analytics), competitor research (mine your core audience's server tags and past games to find what they play beyond the recommendation feed).
- **Core audience**: dedicated playtesters who out-play you. Plan and playtest with them, but discern: they are players, not game designers. The player is usually right, not always.
- **Cadence**: launch, plan next same day, assign next day, build midweek, playtest internal then core on Friday, launch Saturday.
- **Dos/don'ts**: listen and talk to your audience; test before launch; watch small YouTubers play (sort by posted today, low views) to find friction; prefer internal team over big studio when resources allow; don't prioritize monetization over gameplay (pay-to-win kills); don't do last-second updates; don't please everyone or implement every suggestion (can fry the economy); don't get lazy ("we made it, don't need to touch it" kills games); don't push updates that create no engagement.
- **Sunk cost fallacy**: players keep playing due to invested time/money/effort; design updates that deepen emotional investment in progress (e.g. build mode where new players build safely before facing pressure).
- **Retention lens**: Roblox discovery accounts are D28: continuous content keeps the algorithm feeding fresh engagement.

LiveOps should complement or deepen the core loop. For each event or update, define:

- target audience and KPI;
- intended player actions;
- economy sources, sinks, and reward impact;
- communication before and during the event;
- hourly health checks during launch;
- comparison with pre-event and post-event periods;
- what remains after the temporary event ends.

Do not use event spikes as proof of durable retention. Compare later cohorts and ordinary weeks.

## 9. Audit Workflow

When asked to audit a Roblox game:

### Step 1: Request evidence

Ask for what exists, not an idealized dashboard dump:

- game link and intended audience;
- Home recommendation impressions, play through, bounce, play days, playtime, and important signals;
- acquisition by source;
- first-session retention and onboarding funnel;
- D1, D7, and D30 cohorts;
- session time and playtime;
- payer conversion, ARPDAU, ARPPU, products, and economy health;
- device, locale, and country/region breakdowns;
- errors, crashes, frame rate, and recent update dates;
- thumbnails, icon, title, description, and reduced-exposure banner;
- player feedback and observed sessions.

### Step 2: Establish the baseline

Separate facts, inferences, and unknowns. Mark immature D7/D30 cohorts. Note seasonality, traffic-source changes, events, ads, and releases.

### Step 3: Find the narrowest broken transition

Examples:

- impression → play;
- join → player control;
- control → first meaningful action;
- action → first reward;
- reward → core-loop completion;
- first session → return;
- retained player → value-aware shop visit;
- purchase intent → completed purchase.

### Step 4: Prioritize

Use a simple evidence-weighted score:

> **Priority = expected player impact × confidence × reach ÷ cost and risk**

Do not fabricate precision. A qualitative High/Medium/Low score is often more honest.

### Step 5: Produce an experiment backlog

For each recommendation include:

- evidence and uncertainty;
- hypothesis;
- smallest viable change;
- primary metric and guardrails;
- eligible cohort and segmentation;
- instrumentation required;
- expected decision date;
- rollback trigger.

### Step 6: Preserve the game's identity

Optimization is not a license to turn every game into the same simulator loop. Protect the intended fantasy, audience, tone, accessibility, and creative distinction. Reject metric gains that depend on misleading acquisition or damaged player trust.

## 10. Output Format

Use this structure for a game-design diagnosis:

1. **Verdict:** the highest-leverage constraint.
2. **Evidence:** verified facts and the source/date range.
3. **Unknowns:** missing evidence that could change the diagnosis.
4. **Hypotheses:** ranked, not stated as facts.
5. **Next experiment:** one smallest interpretable intervention.
6. **Metrics:** primary outcome, counter-metrics, and decision rule.
7. **Implementation routing:** which Roblox Brain skills are needed.
8. **Later backlog:** useful work deliberately excluded from the first test.

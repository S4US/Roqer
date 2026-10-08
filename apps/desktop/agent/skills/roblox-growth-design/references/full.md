# Roblox Growth Design: Full Reference

Sections marked **Official** describe documented Roblox behavior. Other examples, thresholds, and models are starting points to test, not verified ranking rules. Specific unverified hypotheses are marked in place.

## 1. Operating Model

A game-design diagnosis should connect four layers:

1. **Promise:** what audience the title, icon, thumbnails, and premise attract.
2. **First session:** join reliability, comprehension, time-to-fun, and the first core-loop payoff.
3. **Long-term game:** progression, variety, social value, identity, mastery, and LiveOps.
4. **Business:** transparent products that add player value without damaging trust or the economy.

Do not jump from a weak metric to a feature prescription. A metric is an observation. Several causes can produce the same observation, and one change can move several metrics.

### Evidence hierarchy

Use the strongest available evidence:

1. Roblox Experiments with an adequate minimum detectable effect (MDE), full planned duration, confidence intervals, and stable variants.
2. Cohort or release comparisons with acquisition source, platform, locale, player age, and seasonality controlled where practical.
3. Funnels, session traces, errors, performance reports, economy sources/sinks, and behavioral telemetry.
4. Moderated playtests, player observation, support reports, surveys, and community feedback.
5. Competitor teardown and informed judgment.

The lower levels generate hypotheses. They do not prove causation.

### Experiment brief

Before changing the game, write:

- **Observation:** what moved, for which cohort and date range?
- **Hypothesis:** if we change Y because evidence Z, metric X should move.
- **Primary metric:** one measure tied to the hypothesis.
- **Guardrails:** metrics that must not regress, such as errors, D1, economy inflation, payer complaints, accessibility, or mobile frame rate.
- **Exposure:** eligible players, control, variant, rollout, and planned duration.
- **Decision rule:** what confidence and practical effect justify shipping?

Roblox Experiments run for 14–60 days. Do not use first-day results for decisions, stop because a favorable line appears, or claim a causal win without statistical significance. Stop or roll back for safety, severe regressions, broken instrumentation, or invalid exposure. Games below roughly 1,000 daily active users may struggle to detect useful effects; use the dashboard's MDE rather than inventing a universal traffic threshold.

**Experiments mechanics (official).** In-game experiments apply per-player config values; matchmaking experiments test matchmaking configs (only one matchmaking experiment at a time; recommend 100% rollout to avoid isolating players). Implementation:

- Use `ConfigService:GetConfigForPlayerAsync(player)` (not `GetConfigAsync`) to get a player-specific snapshot. `GetValue` on that snapshot enrolls the player; the first call is random, every later call returns the same variant for the experiment duration.
- Call `GetValue` as late as possible. Calling it early enrolls players who never reach the feature you are testing.
- Target enrollment with your own criteria: check the condition (e.g. new player), then enroll only those players (e.g. `racesCompleted == 0`). For cross-session persistence, store the assignment.
- Experiments track all metrics (D1, D7, playtime, ARPU, ARPPU, payer conversion, session time) regardless of the goal metric you pick. Use the Results tab after completion; a metric is significant when its confidence interval does not overlap 0%. Use "Make decision" to promote a variant to the default config.

**Experiments best practices (official):**
- Start with a written cause-and-effect hypothesis.
- Use the MDE to decide if the experiment is worth running; if the MDE is too high (e.g. >100%), statistical significance is unlikely.
- Let experiments run their full duration: the novelty effect can skew early results in and out of significance.
- Don't act without significance. If one metric is up and another down, decide whether the trade-off is worth it.
- Avoid unrelated changes during a running experiment; they can invalidate results. Only run simultaneous experiments if confident they won't interact.
- Use confidence intervals for deep dives; a too-wide interval means the metric may never reach significance.
- Balance experiment results against qualitative player feedback and the product vision. Experiments are probabilities, not certainties.
- Document findings and decisions as a body of knowledge.

### Acquire evidence before diagnosis

Ask for the evidence that actually exists: Creator Dashboard screenshots or exports, cohort windows, release dates, acquisition mix, session recordings, and player feedback. Use Studio or project telemetry for runtime facts when available. State what is missing and never fabricate a metric, cohort, or causal explanation.

### Static project structure: hypothesis only

A static `.rbxl` or `.rbxm` can reveal implementation structures, not player success, usability, retention, conversion, or fun. Use a short handoff:

1. **Observe:** name the structure and evidence boundary.
2. **Question:** translate it into a player-facing question.
3. **Instrument:** choose the smallest success and abandonment events that can answer it.
4. **Test:** use observation, logs, cohorts, or an experiment. Keep static evidence and measured outcomes separate.

## 2. Official Home Recommendations Model

<!-- temporal: 2026-07 -->

Roblox's **Recommended for You** system has two stages:

### Retrieval

The system selects a personalized subset of games using signals such as engagement, retention, and monetization. Sponsored ads, search, charts, friends, teleports, notifications, curation, and external sharing can bring initial players and help a game receive consideration for organic discovery.

### Ranking

The system ranks retrieved candidates for each user. How far organic Home distribution expands depends on users acquired through Recommended for You. Engagement, retention, and monetization from users first acquired through ads, search, friends, social media, or another source do not enter this ranking stage.

This distinction matters:

- external acquisition can create a useful seed cohort and revenue;
- external cohort behavior is still valuable product evidence;
- it does not directly repair weak organic Home-ranking signals.

### Current signal groups

Roblox says signal influence changes over time. Treat this as a dated map, not a permanent formula.

**Most important**

- **Play through rate:** users who play after a Recommended for You impression.
- **First-play bounce rate:** users leaving after a short first play, segmented at under 60 seconds and 61–180 seconds. This is negative.
- **Play days per user:** average unique play days across D1, D2–7, and D8–28 windows.
- **Playtime per user:** capped for this signal at 60 minutes per user, per game, per day.

**Important**

- intentional co-play days per user;
- qualified play sessions per user;
- spend days per user;
- Robux spent per user.

These are per-user averages. Smaller games are not automatically disadvantaged by lower total player counts.

### Explore, expand, and context

Roblox explores a game with cohorts and can expand distribution when those cohorts respond well. Impression changes are also affected by:

- game updates and gameplay changes;
- recommendation-system changes;
- weekly, school-year, summer, and holiday seasonality;
- competing games improving faster;
- audience expansion into less perfectly matched cohorts.

A temporary decline in play through rate can accompany an impression increase. Do not treat every movement as a penalty or secretly changed feature weight.

### Dashboard workflow

In Creator Hub, use **Analytics > Acquisition > Home Recommendations** (also surfaced in the Creator Analytics Overview page):

1. Inspect Home recommendation impressions and plays.
2. Check the most important signals first.
3. If those are stable, inspect co-play, qualified sessions, spend days, and Robux spend.
4. Compare against similar-game benchmarks as rough context only. Benchmark games do not affect ranking.
5. Segment other acquisition sources separately.

<!-- temporal: 2026-08 -->

### 2026-08 RFY direction (Roblox CGO announcement)

Roblox's Chief Growth Officer stated the next Recommended-for-You update (targeted late August / early September 2026) will better recognize long-term player value: games players return to over time, and where players find value in purchases. Source: DevForum announcement, 2026-08-06.

Working guidance from the same post:

- If retention is low, fix core gameplay first: first session clarity, a satisfying core loop, reasons to return, and iteration from feedback and analytics. Monetization alone cannot carry a game players do not keep playing.
- If retention is strong, build sustainable monetization: value players can feel, offers integrated into progression rather than interrupting play, fair and transparent pricing, and continued content investment.
- Both retention and monetization drive Home impressions; games strong in only one still receive recommendations, but games strong in both may get broader distribution.
- Four factors move Home impressions: your own gameplay/updates, platform algorithm changes (announced transparently), seasonality (weekly peaks on Saturdays, summer/holiday/school cycles), and competing games improving faster. A drop while your signals are steady can be competitive, not punitive.

Treat the timing as temporal; re-check the announcement thread for launch status before citing the update as live.

### A working model of the algorithm

This model of Home recommendations is based on experience, not Roblox's published ranking rules.

**Traffic is learned from, but ads are cold traffic.** A new game needs initial traffic before it can be ranked; ads or short-form content (TikTok/YouTube clips) provide it. Ad traffic is the cheapest, least-qualified audience ("cold"): low engagement, low spend, low D1. Roblox uses ad traffic mainly for initial data to gauge the game and its audience. Home-algo traffic is the qualified audience: higher D1, D7, playtime, and spend. Do not panic if launch stats look bad on ad-sourced players.

**Ranking is progressive (unverified hypothesis).** Roblox docs state benchmark games do not affect ranking (see §2 Dashboard workflow). Separately, an operator model hypothesizes progressive staging: first against the broad genre (all games with similar loops/mechanics, including adjacent genres), then against "experiences with similar players": games your players also play (Analytics > Acquisition > Home Recommendations > benchmark). Practically, treat that benchmark as the competition that matters: this is where stats usually take a hit relative to the cohort, and where games with better stats steal your players (winner-takes-most). The staging mechanism itself is unconfirmed; do not cite it as a ranking rule.

**Ads money does not buy Home placement.** After initial data collection, ad players' statistics do not feed Home ranking (except some caveats). Running more ads without improving stats does not get you into the Home market; it only buys sponsored placement. The lever is meaningful stat-improving updates: run ads → collect data → find worst stat (D1, D7, playtime) → ship an update that improves it → rerun ads to re-feed data on the improved game. Updates move you up the ranking, not ad spend.

**The 28-day signals window (June 2026).** Roblox's RFY algorithm directly measures longer-term retention across Day 1, Day 2–7, and Day 8–28. The pre-June rolling "7-day window" guidance is stale. Optimize onboarding for D1, early loops for D2–7, and content cadence for D8–28; the skill's official §2 retention windows above match this.

**Beta mode (official feature).** While in Beta mode, your experience is not shown in Home recommendations. Use it to tune metrics with cheap ad traffic before opening to the algorithm, so the first Home exposure has already-optimized stats.

**June 2026 metric change (reading of official docs).** QPTR was split into **Play-Through Rate** (PTR: % of Home impressions converting to play sessions) and **First-Play Bounce Rate** (negative stat: % of players leaving within 60s; also a 61–180s bucket). D28 is now tracked. Bounce rate is a negative signal, so keep it low; clickbait/mystery-game packages that exploited QPTR are "cooked" because bounce rate now exposes them, and template clones and misleading titles suffer. **Experience detail page CTR** (users who played from detail page / users who viewed it) matters for overall PTR: put your best thumbnails and gameplay description there, not just on the Home tile.

**Game-as-funnel framing.** Think of the game as a funnel: Home impression → detail page view → play session → engagement → retention. Optimize the whole funnel, not just the thumbnail. Find and fix the single biggest bottleneck first (impression, detail page, bounce, D1, D7, D28), not everything at once.

**Diagnose with "rows" not totals.** In the Creator dashboard, slice engagement and funnels by device, platform, locale, and source. A game with good overall tutorial metrics can be terrible on console or mobile, and that friction caps growth. Console players play long and often; don't skip console.

**The 250 highly-engaged-player requirement (2026 platform change).** Games published for all-ages audiences are first available only to age-checked 16+ users until they complete Roblox's Kids/Select evaluation. Confirmation comes from Roblox's real-time multimodal moderation of player engagement (account age, play history, platform spend) verifying that players are genuine, not bots. Roblox's own definition of a highly engaged player: meets requirements on account tenure, playtime in your game, and platform spend, where platform spend means a minimum purchase **anywhere on Roblox in the last 60 days** (they do not need to spend in your game) **and** time spent in your game within that same window. The exact criteria "will evolve"; re-check the kids-and-select doc. Operator-reported dynamics (not official docs):

- Ads are served 16+ automatically with Roblox-recommended targeting; you do not need to target 16+ players yourself.
- You can hit Home algorithm placement before clearing the 250 threshold.
- The fastest path is ads for initial traffic, then Home impressions accelerate the count (engaged players come from Home faster than from ads).
- Anecdotal spend: roughly $16/day for ~2 weeks (~$180) hit the threshold from ads alone; one dev saw 190 in 2 weeks from 210K ad visits, then 350 more from 90K Home visits in 5 days.
- Not a huge new cost: similar to what launch ads already cost; commissions are an option if you cannot fund ads.
- **25 vs 250 thresholds (official).** The 250 unique plays by highly engaged players within 60 days is the Kids/Select **evaluation** requirement and applies to games published to all ages. Separately, the refundable **publishing fee** (1,000 R$) is refunded when your game maintains **25** highly engaged players for 60 days; the **expedited review fee** (100,000 R$) is refundable after 90 days if you maintain **25** highly engaged players. Different thresholds, different purposes. Do not conflate them.
- Fast track (official, shipped): the **expedited review fee** (100,000 R$/game, 48-hour review) lets timed launches reach kids/Select before the 250 bar; refundable after 90 days with 25 highly engaged players. See publish-games-and-places doc.

Source: official Roblox docs (kids-and-select, publish-games-and-places) plus operator reporting, June 2026; the operator dynamics above are experience-based. Re-check the docs for rollout status before citing as live.

## 3. Diagnose Metrics Without Single-Cause Thinking

### Low play through rate or thumbnail QPTR

Likely hypotheses:

- icon or thumbnail is unreadable at actual mobile size;
- the image does not communicate genre, action, fantasy, or tone;
- packaging attracts an audience the game cannot satisfy;
- the premise is too familiar without a clear distinction;
- a recent impression expansion reached a broader cohort.

Evidence to collect:

- Home Recommendation play through rate;
- thumbnail personalization QPTR by thumbnail and winning segment;
- qualified plays and average playtime per active thumbnail;
- mobile and desktop previews;
- mismatch between packaging promise and observed first session.

Do not use generic clickbait. A higher click rate paired with worse bounce or retention is not a win.

### High first-play bounce or weak early session survival

Investigate in this order:

1. join failures, crashes, errors, device memory, frame rate, and long loading;
2. metadata-to-game promise mismatch;
3. unclear controls or goal;
4. mandatory menus, dialogue, character creation, or tutorial before meaningful action;
5. first payoff arriving too late;
6. dead or confusing social spaces;
7. platform-specific input or UI failure.

Instrument milestones such as join complete, player gains control, first meaningful action, first reward, core loop complete, and session exit. Track negative outcomes too, such as a failed fight or blocked purchase prompt.

### Low D1 retention

Roblox points to three broad areas: core loop, first-time user experience, and performance.

Useful hypotheses:

- the core loop is understandable but not enjoyable;
- players enjoy one cycle but see no reason to return;
- onboarding teaches mechanics without communicating purpose;
- progression is invisible or the first goal feels arbitrary;
- starter resources do not let players sample the fun;
- mobile, localization, accessibility, or reliability failures affect a segment.

A brief tutorial or contextual tooltips can help. "No tutorial" is not a rule. Teach only the essentials, get to meaningful play quickly, deliver a joyful first payoff, and preview future progress.

- Instrument Funnels on every tutorial step to find the exact drop-off step, then fix that step specifically rather than redesigning the whole flow.
- "Show, don't tell" is a strong default for younger audiences: let players learn by doing (plant a seed and watch it grow) rather than reading a text block. Some control schemes still require text; keep it brief and contextual.
- Give a concrete reason to return tomorrow: a crop that finishes growing, a daily reward that escalates, a friend's base to visit.

### Low D7 or D30 retention

Do not reduce this to adding daily rewards. Investigate:

- short-, medium-, and long-term goals;
- progression speed and difficulty;
- content variety and mastery depth;
- collections, identity, customization, or status;
- healthy co-play, parties, guilds, competition, and cooperation;
- endgame and recurring reasons to return;
- LiveOps cadence and whether updates deepen the core loop;
- economy inflation or old content becoming obsolete.

D7 often exposes progression weakness. D30 often exposes endgame, content cadence, social value, or exhaustion. The boundary is not absolute.

- A week of distinct content or goals gives D7 something to chase: a new zone, a rank, a collectible set, a limited-time event.
- Social-flex features (rare cosmetics, leaderboard placement, "admin abuse"-style novelty items players show off) give returning players something to signal status with.
- Live events on a regular cadence give lapsed players a reason to re-open the game.

### Low average session time

Check whether players reach the fun, then whether the loop sustains interest:

- time to first meaningful choice;
- action density versus waiting and travel;
- reward feedback and goal clarity;
- loop variety and escalating challenge;
- social interaction where it genuinely fits;
- performance degradation in longer sessions;
- natural stopping points and return hooks.

Give every core-loop action immediate feedback. A rock hit plays a sound and adds slight camera shake; a coin collected pops and increments a visible counter. SFX + VFX on small actions makes the loop feel alive. Test whether feedback density actually moves your playtime before assuming it will.

Longer is not always better. Respect natural sessions; do not trap players with friction or punish leaving.

### Low payer conversion

Investigate product value and purchase friction:

- can players find and understand the shop?
- is the product useful, expressive, durable, or fun?
- does the product fit the player's current progression?
- are there transparent options at several price points?
- does onboarding show value before asking for payment?
- does the funnel fail before or after a Roblox purchase prompt?

A lower-cost first-purchase offer is one hypothesis, not a default. Measure downstream retention, refund/support sentiment, and economy impact.

- A very cheap starter pack (under 50 Robux) removes the "first purchase" barrier; the goal is converting a non-payer into a payer, not maximizing that transaction.
- Cheap repeatable consumable developer products (e.g., 19 Robux to double offline earnings on login) build a purchasing habit without requiring a large commitment.

**Official item taxonomy.** Purchasable items are durable (unlimited uses, e.g. skins) or consumable (limited uses, e.g. boosts), and each is enhancement (improves capability: speed, protection, tools, event access) or expression (personalizes: skins, emotes, pets). Know what is being sold, where, and how, and make the purpose of each item legible to the player: a purchasable item should have visible value (Roblox's example: a flashlight in *Doors* that players immediately understand aids exploration). Describe items accurately and truthfully.

**Official shop design.** The shop is the experience's economy information hub, not just a market. Make it:
- **Integrated**: consistent icon/UI, quick in and out without disrupting play;
- **Contextual**: players need surrounding context to judge an item's value; explain items in relation to gameplay and each other (a "Revives" explanation teaches that reviving is core, limited functionality);
- **Inviting**: a destination to linger and browse; rotating or new stock gives players a reason to revisit.

Season passes are a documented delivery vehicle for cadence content (official creator-docs page: season-pass-design), though in practice few Roblox games run a classic paid-track pass. A good season pass: follows shop best practices, offers **free and premium tiers** (free keeps non-payers earning; premium is a superset rewarding payers), has **attractive rewards** previewed and tied to the core loop, a **manageable timeframe** (reward spacing relative to average session time; short and long missions; clearly communicated XP levels), and clear remaining-time communication.

### Low ARPPU or ARPDAU

Low ARPPU can mean the catalog lacks depth for engaged payers, but it can also reflect audience, regional pricing, product mix, or a healthy low-pressure economy. Consider durable and consumable options, seasonal products, and meaningful catalog variety.

Always inspect ARPDAU and payer concentration. High ARPPU with low ARPDAU can mean revenue depends on a narrow subset. Do not design around "whales" or use coercive scarcity, deceptive odds, pay-to-escape friction, or manipulative loss aversion.

Tiered pricing ("small / medium / large fries") gives engaged payers somewhere to go: a basic pack, a pro pack, and an expensive overpowered pack. The expensive tier exists for players who want to spend; the cheap tiers keep the majority comfortable. Test whether your audience actually has a high-end segment before building for one.

### Declining impressions

Do not assume a shadow penalty. Check:

- Home signal changes by their documented priority;
- recent updates and regression dates;
- acquisition-source mix;
- seasonality;
- broader-cohort exploration;
- competing games and changing audience preferences;
- a Creator Dashboard reduced-exposure banner.

## 4. Positioning and Idea Validation

### The purple-ocean lens

Seek proven demand with a clear twist rather than a pure clone or an idea with no demonstrated audience.

Use it as a research lens:

1. **Demand:** are players already seeking this fantasy, mechanic, or genre?
2. **Supply:** which games serve it, how concentrated is the audience, and what do reviews or communities dislike?
3. **Difference:** can a player explain this version's distinction in one sentence?
4. **Roblox fit:** does it benefit from avatars, co-play, user identity, short sessions, touch controls, or social graph?
5. **Production fit:** can this team deliver the content, moderation, economy, and update cadence?
6. **Evidence:** what cheap prototype or packaging test could falsify the premise?

Treat third-party estimates as directional. Public CCU, favorites, visits, review activity, social views, Steam wishlists, and Google Trends measure different populations and can be gamed or misread.

### Trend lifecycle

Roblox trends tend to move through three phases:

1. **First to market:** an original concept captures initial demand with little competition.
2. **Saturation:** clones and templates flood in; the player base disperses; most copies die.
3. **Mutation:** survivors re-package with a new title, custom thumbnail, or altered core loop. Straight copies of the original's title and thumbnail format fail and can trigger metadata penalties ([operations.md](operations.md) §6).

If you are entering a trend in phase 2 or 3, a straight clone is the worst position. You need a meaningful twist or an underserved sub-audience.

### Off-platform demand signals

Demand proven elsewhere de-risks a Roblox launch:

- Indie games with hundreds of thousands of Steam wishlists or millions of web-game plays show proven desire for the core concept.
- Gameplay videos pulling millions of views, especially with younger audiences, predict the concept can explode on Roblox.
- Being the first to bring a highly demanded fantasy to Roblox in a polished way is a strong entry point.

Check the Roblox side too: search for the concept's keywords. Is it actually done well? A theme saturated with basic RP/sims (airports, firefighters) can host a different genre entirely (action-checkpoint, extraction shooter). That gap is the opportunity.

### Premise checks

A useful concept should answer:

- What does the player repeatedly do?
- What fantasy or identity does that action serve?
- What changes after each cycle?
- Why is this better with other players?
- What can be shown honestly in one icon and one thumbnail?
- What remains fun without spending?
- What production burden grows with success?

### What makes a game take off

A live-game operator's five things that make a Roblox game likely to go viral and keep players.

1. **An idea a kid can picture before bed.** The concept should be something a player would imagine falling asleep to: "a hospital run by animals" (Animal Hospital), "toys that live their own life" (Toy Story), "a city run by animals" (Zootopia). If the packaged title + thumbnail makes a player on the Home page unable to resist clicking, idea works. Test a concept by asking what fantasy the player is fulfilling, not just what the mechanic is.
2. **Great onboarding.** Not a tutorial that drags: get players emotionally invested in the *why* of their actions (title-sequence world-building, cutscenes showing a clearly felt threat), introduce one mechanic at a time, use level design to communicate danger/goals without text, and keep UI minimal during onboarding (Sell Lemons: no UI, fast progression, one mechanic at a time).
3. **Socialization as part of the core loop.** Make the game 10x more fun with friends so friends invite friends (the word-of-mouth flywheel: kids show each other at school/bus). Leaderboards add the social flex; cosmetics and visible progress create FOMO ("that kid is zooming past me"). Even simple social elements beat a great solo incremental with zero interaction.
4. **Simple mechanics with tons of depth.** One obvious mechanic (voxel building, boat building, role-play) that yields near-infinite player expression and session variety ("every session is different": build a new plane, new role, new PvP run). The mechanic must stay easy and frictionless on **mobile** first; on-mobile clunk caps growth even when desktop is fine.
5. **Clippable / strong community.** Design for content creators: visualize what a YouTuber/TikToker would clip from your game, and make those moments frequent and obvious. Community-created content (build showcases, unique hiding spots, crazy plays) compounds virality; watch the moments creators actually include and double down on them. A strong community keeps a game at 8–9K CCU for years.

**Study top games, copy functionality not style.** Play successful games in the genre (especially on mobile and console), understand *why* their onboarding/funnel/social choices work, and copy the function, not the aesthetic one-for-one. Diagnose toy friction by running your own game with a fresh account and watching where a new player gets stuck.

### Production playbook for fast shipping (supplementary)

A live-game operator's process for shipping quality fast, from a producer who runs a two-man team. Distilled from an operator video on pumping out high-quality Roblox games quickly.

- **Execution is the bottleneck, not ideas.** Ideas are cheap and everywhere; the scarce resource is reliable execution. A big team is not a flex; top studios run lean (4-person or even 2-person) teams.
- **Get the MVP core loop done first.** Scope a minimal viable product (core loop only) so you can playtest whether the game is fun before investing in the full vision. Use AI (e.g., Claude) to prototype with basic parts and free models before hiring any dev.
- **The game design document is the contract.** A GDD (what players do, leveling, economy, progression) doubles as the statement of work for the programmer. Turn it into per-role Trello columns and actionable tasks per system.
- **Sequence the build: art/UI/models first, programmer second.** Programmers are more productive in a populated workspace; delivering builds/models/UI before scripting keeps execution fast.
- **Communicate visually and asynchronously.** Use recorded video (Loom-style), screenshots, and references to existing games rather than long text; most "wrong work" is a communication gap, not a skill gap. Prototype small ideas with AI first to avoid paid-dev round-trips.
- **Hire T-shaped people.** One person who does programming + UI, or building + modeling + animation, beats a bigger brittle team. Same time zone matters for fast iteration.
- **Reputation and vetting beat money.** In the Roblox talent pool (often young), trust decides everything: hire via Twitter/YouTube presence, prefer paid-upon-completion (never pay in full up front; that kills delivery), always sign a contract, make a new contract for new scope, and don't sneak unagreed work into scope mid-project (it breeds resentment and slows the team).

### Core-loop design

Write the loop as:

> **Action → feedback/reward → progression choice → more expressive or demanding action**

Audit:

- Is the repeated action itself enjoyable?
- Is feedback immediate and readable without relying only on sound, color, or motion?
- Does progression create decisions, not only larger numbers?
- Can a new player complete a meaningful cycle quickly?
- Can the primary action be expressed well on touch, gamepad, and keyboard/mouse, or does one platform require a different interaction model?
- Does the loop remain legible on lower-end devices?
- Does co-play improve the experience rather than merely add bodies?

Prototype the uncertain mechanic before building a large content shell. Prioritize from observed player behavior and the cost of being wrong.

**Operator heuristic (80/20):** build roughly 80% from proven mechanics, UI, and progression patterns players are already trained on (core loops, upgrade systems, map layouts from top games in the genre), and spend roughly 20% of your differentiation budget on the theme, fantasy, or twist. The ratio is a starting lens, not a law: a genuinely novel mechanic may need more invention, and a reskin may need less. The point is that familiarity lowers the comprehension barrier while novelty supplies the reason to click.

### Launch, sponsoring, and idea selection


**Sponsoring checklist.** How to run launch sponsors without burning money or misreading data.

*Do:*
- Run sponsors at least 3–4 days before judging them.
- Keep sponsors consistent: swapping in new sponsors resets the learning period and makes CCU bounce around.
- Spend a steady, modest amount (~16 ad credits/day) instead of dumping a ton of money in. Total spend doesn't change the end result, only how fast you get there.
- Wait for 10k+ visits before trusting playtime or session data; below that it's basically noise.
- Work the game page itself (title, thumbnail, description): good CTR is worthless if viewers don't convert to plays.
- Add a code in the description to give people a reason to play: it converts better.
- Test an all-caps or punchier title if conversion seems weak.
- Be patient and methodical; the whole process is a waiting game.

*Don't:*
- Don't keep launching new sponsors: every new one relearns from scratch, which causes CCU to dip and stay volatile.
- Don't clickbait the title or thumbnail: clicks that never turn into qualified plays actually hurt with the algo.
- Don't trust early playtime data at low visit counts.
- Don't assume more money buys a better outcome: it speeds up the timeline, it doesn't raise the ceiling.
- Don't let cost per play (CPP) sit at 0.005+ and call it good enough; under ~0.005 is the target, and there's always room to improve even when CTR looks fine.
- Don't overhaul everything in one shot: change one thing at a time so you can tell what moved the needle.
- Don't let one bad-looking metric make you panic-pull the plug: CCU, playtime, and retention only really mean something once the game has scale.

**Targeted-stat updates.** A good update rhythm: pick one stat per update (e.g. to raise session time, add activity rewards that unlock after a set time in-game), ship it, then monitor that stat after the update. Combined with the funnel framing in §2, this keeps cause and effect legible.

**Idea validation and execution.** How to choose and pressure-test ideas before committing months.

- **An idea's job is to make design easier.** Grow a Garden came from offline growth: plants made "something grows while you are away" clearer than a rock would. If an idea creates design problems, pivot.
- **Match the idea to the team's history.** A simulator team should make simulator-style ideas; a team without FPS experience should not jump into a zombie shooter; solo devs start simple and scale from past work.
- **Stress-test with the core loop only.** Build just the core loop, make it satisfying, then test with people who already like that niche; feedback from outside the niche misleads.
- **Release fast, update weekly.** Don't spend two months on one unproven game; learn from failure and iterate on quality of life. Simple ideas are harder to think of than complex ones but better for learning.
- **Every original game is an iteration.** Fast teams can chase trends; slow teams should bet on originality, which is harder to copy.
- **Tie the comeback reason to the real goal,** not just cash or daily rewards.
- **The team must enjoy the game itself.** If nobody wants to play (or AFK) before launch, it isn't strong enough.

**Business and deal notes.**

- **Clip value test:** show the game to YouTubers and ask whether funny or shareable moments happen naturally. If it produces Shorts/Reels/TikTok material, creators may promote it for free, and you can clip it yourself.
- **YouTube traffic inflates stats:** viewers already understand the game from watching someone else learn it, so session time and retention look stronger than they are. Home recommendation stats matter more for judging true platform growth (cf. §2's external-traffic caveat).
- **Deal structure:** pay on completion to lower scam risk; contracts for equity, with equity matching real contribution; define in the contract what equity holders keep doing after launch.
- **Selling a game:** ask whether the buyer will scale it or kill it. If they'll kill it, selling more of it may make sense; if they can scale it, sell as little percentage as possible. Avoid buyers who only collect near-term revenue.
- **Outsource creative only if it beats your own stats**: outsourced thumbnails that underperform your own work are a downgrade, though hiring makes sense when you lack the skill.

### Launch realities

Complements the sponsoring checklist above with the unglamorous parts.

- **Onboarding friction budget**: every required input between loading screen and gameplay loses players (welcome popups, unskippable intros, team/save-slot selects, fancy menus). First-session UI should be one bouncing button with an arrow and circle cutout, and even then ~5% of players won't click it. Use world beams, UI cutouts, finger pointers; auto-choose everything optional and drop the player into the game. Instrument every onboarding step with `AnalyticsService` funnels; first-time results are always a surprise.
- **Split ad campaigns by platform**: desktop and mobile CTR differ enough that combined campaigns produce useless data. Targeted low spend (5 credits/day with platform/gender/genre targeting) can beat larger untargeted spend (10–15/day). Match creative to audience (don't promote a cutesy dress-up game to boys).
- **Algo "biting" is visible before players arrive**: watch impressions-by-thumbnail (Places → Place → Thumbnails) while running launch ads; first impressions/hour show up before CCU moves. Expect a bumpy ride: spikes to thousands then 0. Don't touch thumbnails or stop ads mid-spike.
- **Paid vs organic gap**: ad-sourced playtime can be less than half of Home-sourced (observed: 8 min from ads vs 19 min from Home on one game). Check Acquisition → New User Funnel → Engagement by source to preview organic stats before turning ads off.
- **Console is a cheap niche**: small audience but often longer playtimes (sometimes overtakes desktop) and cheaper ads. Worth a gamepad-comfort pass.
- **Low-CCU stats are noise**: one random player can triple daily playtime; D1 can swing from ~0% to 10%+ day to day. One dev's "3% D1 is a lost cause" games now sit at 9–13%. Learn your own baseline; don't make kill/keep decisions on small samples, and don't retire daily rewards because D1 spiked once.
- **Don't trust The Spike**: a 400-CCU peak can decay to 1–2 despite dozens of updates and thumbnail tests. The algo gives and takes.
- **Negative ratings are unavoidable**: kids downrate for bugs, performance, UI, obvious AI use, niche gameplay, difficulty. Counters: volume of happy players (e.g. like-and-join-the-group rewards) or a flawless game: nothing else.
- **Make feedback frictionless**: custom feedback forms persisted to a DataStore, with the button surfaced at decision popups (rebirth confirmation, level completion). Negative feedback beats friend praise; decode trashtalk for its signal (boring, confusing, too hard, too easy).
- **Multiplayer games need singleplayer fallbacks**: coop/versus games die fast when CCU can't fill servers, and they need higher ad spend. "Waiting for more players" screens kill joins. Warmup modes, fun tutorials, bots, and lobby minigames help.
- **Streaming can beat shorts** (TikTok live especially): viewers want to play with the developer, stay longer, and purchase to support (if the game looks exciting on stream). Dev-streams also work. Game must be visually interesting; that's the bar.
- **Shorts/TikTok mechanics**: strong hook in the first seconds; no links (algo may penalize as spam), game name only (bait comments asking for it); conversion from views to plays is tiny but pre-qualified; needs 1–2 weeks of sustained posting. If nobody watches and plays, that's hook feedback, not platform failure.
- **Mindset**: your game dies when you decide it's dead. Most games are a long fight for every active player, not a front-page week. But know when to quit and re-ship (see §4 trend-lifecycle: failed games are usually re-shipped as new games, not revived).

## 5. First-Time User Experience

Design for **play-first teaching**, not "players never read." Some controls and systems require text. Make instruction brief, contextual, localized, and accessible.

Roblox's retention guidance recommends reaching the fun within about five minutes. Treat that as a diagnostic starting point, not permission to rush a complex control scheme.

A first-session sequence can be:

1. safe arrival with the game responsive;
2. one obvious action and immediate feedback;
3. one small choice that expresses agency;
4. first core-loop completion;
5. a joyful payoff;
6. visible next goals;
7. optional deeper explanation after motivation exists.

**Official onboarding mechanics.** The FTUE succeeds on two metrics: D1 retention and onboarding goals (teaching essentials, getting to fun quickly, leaving players wanting more). Practical levers:

- **Player XP-based leveling**: keep early-level XP thresholds low so players level up fast and feel progression immediately. Tune thresholds with Configs in real time without shipping an update.
- **Starter items and currency**: free equipment/soft currency lets players sample utility or expression early. Find the balance with Experiments (gift different starting amounts), then push the winner as a Config.
- **Goals and moments of joy**: surface short/mid/long-term goals in highly visible places (skill trees, season passes, quests, collections); end onboarding with an intentionally designed moment of joy (rewards, delightful animations, celebratory VFX).
- **Funnel instrumentation**: list core-loop steps, track completion rate per step (with special in-game items as step markers), track negative outcomes (lost fights, blocked purchases), and fix the biggest drop-off. Target the funnel with Experiments on specific steps (shorter dialogue vs guided arrow) to get causal answers.
- **Social FTUE**: if the game is social-first, use Experiments on matchmaking parameters during FTUE to find groupings that improve long-term engagement.

Observe representative players rather than relying on teammates who know the game. When testing with minors, use appropriate consent, privacy, safeguarding, and moderated research practices. Do not collect unnecessary personal data.

**Mobile friction:**
- Mobile UX fails by "death by a thousand cuts": each tiny friction point is tolerable alone but they accumulate until the player quits.
- Hand the game to a target-demo player on a phone or tablet, explain nothing, and watch. UX failures, stuck points, and frustrations surface immediately.
- Remove tap tedium: if upgrading takes 500 taps, add "Buy 100" / "Max Buy" buttons on the HUD.
- Keep maps compact and action-dense. Excessive walking between points of interest kills engagement, especially on mobile. Proven compact layouts (floating-island style, hub-and-spoke) get players into the action faster.

### Accessibility and device coverage

At minimum check:

- touch targets and thumb reach;
- gamepad focus and keyboard/mouse controls;
- readable text at supported text sizes;
- sufficient contrast and symbols in addition to color;
- captions or visual cues for sound-only information;
- reduced-motion behavior;
- localization expansion and bidirectional layout where relevant;
- lower-end mobile memory, thermal load, frame rate, and network conditions.

Cross-reference `roblox-input`, `roblox-ui-design`, `roblox-gui`, `roblox-localization`, `roblox-performance`, `roblox-audio`, and `roblox-animation-vfx` for implementation.

## Further references

- [operations.md](operations.md): §6 packaging and metadata, §7 monetization with trust, §8 social design and LiveOps, §9 audit workflow, §10 output format.
- [community.md](community.md): §11 community benchmarks and launch observations.

## Sources

Official Roblox sources, reviewed 2026-08-02 (RFY direction update reviewed 2026-08-07):

- [Discovery](https://create.roblox.com/docs/discovery)
- [Analytics essentials](https://create.roblox.com/docs/production/game-design/analytics-essentials)
- [Acquisition](https://create.roblox.com/docs/production/analytics/acquisition)
- [Retention](https://create.roblox.com/docs/production/analytics/retention)
- [Engagement](https://create.roblox.com/docs/production/analytics/engagement)
- [Monetization analytics](https://create.roblox.com/docs/production/analytics/monetization)
- [Experiments](https://create.roblox.com/docs/production/experiments)
- [Core loops](https://create.roblox.com/docs/production/game-design/core-loops)
- [Onboarding](https://create.roblox.com/docs/production/game-design/onboarding)
- [LiveOps planning](https://create.roblox.com/docs/production/game-design/liveops-planning)
- [LiveOps essentials](https://create.roblox.com/docs/production/game-design/liveops-essentials)
- [Content updates](https://create.roblox.com/docs/production/game-design/content-updates)
- [Monetization foundations](https://create.roblox.com/docs/production/game-design/monetization-foundations)
- [Season pass design](https://create.roblox.com/docs/production/game-design/season-pass-design)
- [Icons](https://create.roblox.com/docs/production/publishing/experience-icons)
- [Thumbnails](https://create.roblox.com/docs/production/publishing/thumbnails)
- [Accessibility](https://create.roblox.com/docs/production/publishing/accessibility)
- [Regional pricing](https://create.roblox.com/docs/production/monetization/regional-pricing)
- [Price optimization](https://create.roblox.com/docs/production/monetization/price-optimization)
- [Boost Your Discovery by Building Games People Want to Play](https://devforum.roblox.com/t/boost-your-discovery-by-building-games-people-want-to-play/4779042) (2026-08-06)

[qptr.io](https://qptr.io) and [Creator Exchange](https://creatorexchange.io) are optional third-party research aids, not Roblox sources.

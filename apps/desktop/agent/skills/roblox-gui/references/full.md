# roblox gui: full reference

> Code examples are illustrative. Adapt them to your project and verify in Studio before production use.

The most reliable Roblox UI is layout-driven, state-aware, and tested at more than one aspect ratio. The examples below use native UI objects and do not require a UI framework.

## 1. Choose the container

- `ScreenGui`: a 2D overlay attached to a player's screen.
- `SurfaceGui`: controls rendered on a part or attachment.
- `BillboardGui`: a camera-facing label or panel in the 3D world.
- `ViewportFrame`: a UI region that renders a 3D model preview.

Set `DisplayOrder` deliberately when multiple `ScreenGui` instances overlap. For UI templates in `StarterGui`, set `ResetOnSpawn = false` and keep the `ScreenGui` a direct child of `StarterGui` to clone it once and preserve it across character respawns. Templates with `ResetOnSpawn = true` (the default), or nested indirectly under `StarterGui`, are deleted and re-cloned on respawn. This describes StarterGui template cloning, not every dynamically created `ScreenGui`. Do not set `IgnoreGuiInset` globally without checking how the layout interacts with Roblox's top-bar and safe-area behavior.

## 2. Build from containers

Give each visual region a container with one responsibility: header, content, footer, or modal. Put a layout object inside the container that owns repeated children.

```luau
local panel = Instance.new("Frame")
panel.Name = "InventoryPanel"
panel.AnchorPoint = Vector2.new(0.5, 0.5)
panel.Position = UDim2.fromScale(0.5, 0.5)
panel.Size = UDim2.fromScale(0.8, 0.75)
panel.BackgroundColor3 = Color3.fromRGB(25, 28, 36)
panel.Parent = screenGui

local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 16)
padding.PaddingBottom = UDim.new(0, 16)
padding.PaddingLeft = UDim.new(0, 16)
padding.PaddingRight = UDim.new(0, 16)
padding.Parent = panel

local list = Instance.new("UIListLayout")
list.Padding = UDim.new(0, 8)
list.SortOrder = Enum.SortOrder.LayoutOrder
list.Parent = panel
```

Use `LayoutOrder` as data, not as a visual afterthought. If children are created dynamically, assign their order in the view model or row constructor.

## 3. Scale and offset

`UDim2` combines proportional `Scale` with fixed `Offset`. A common pattern is scale for the outer region and offset for internal padding:

```luau
local card = Instance.new("Frame")
card.AnchorPoint = Vector2.new(0.5, 1)
card.Position = UDim2.fromScale(0.5, 0.94)
card.Size = UDim2.new(0.86, 0, 0, 120)

local sizeLimit = Instance.new("UISizeConstraint")
sizeLimit.MinSize = Vector2.new(260, 96)
sizeLimit.MaxSize = Vector2.new(720, 220)
sizeLimit.Parent = card
```

Use `UIAspectRatioConstraint` for shapes that must remain square or maintain a fixed ratio. Keep text containers bounded so a translated or long string cannot expand the entire screen unexpectedly.

## 4. Text and images

Choose one sizing policy for each text region:

- fixed `TextSize` plus a layout constraint when the content is controlled;
- `TextScaled` only when the allowed range is bounded by `UITextSizeConstraint`;
- `AutomaticSize` when the parent has room to grow and the layout can respond.

Test long strings, empty strings, and missing images. A missing asset should produce a useful placeholder, not a layout collapse. Avoid putting essential game state only in color or iconography.

## 5. Scrolling content

A `ScrollingFrame` needs a clear canvas policy. For a vertical list, put a `UIListLayout` inside it and use `AutomaticCanvasSize = Enum.AutomaticSize.Y` when the project does not need to calculate canvas size manually.

```luau
local scroll = Instance.new("ScrollingFrame")
scroll.Size = UDim2.fromScale(1, 1)
scroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
scroll.CanvasSize = UDim2.fromScale(0, 0)
scroll.ScrollBarThickness = 6
scroll.Parent = content

local list = Instance.new("UIListLayout")
list.Padding = UDim.new(0, 6)
list.SortOrder = Enum.SortOrder.LayoutOrder
list.Parent = scroll
```

Do not nest an automatically growing scroll region inside another automatic scroll region unless the interaction is intentional and tested.

## 6. UI state and server state

The UI should render a snapshot or view model. It may request an action, but the server response determines the final display.

```luau
local HttpService = game:GetService("HttpService")

local state = {
    requestId = nil, -- non-nil while a purchase is pending or its outcome is unknown
    selectedId = nil,
    -- True once the timeout window closed without a correlated answer. The
    -- request stays recorded (requestId holds) so the UI blocks a FRESH
    -- same-intent purchase that could double-spend a purchase that may
    -- still have committed. Reconciliation can still settle it.
    unresolved = false,
}

local function render()
    local busy = state.requestId ~= nil
    -- While a request is recorded (pending OR unresolved), a fresh
    -- same-intent purchase must stay blocked. Only a correlated result or
    -- snapshot may release it.
    buyButton.Active = not busy and not state.unresolved and state.selectedId ~= nil
    spinner.Visible = busy and not state.unresolved
end

local REQUEST_TIMEOUT = 8 -- seconds; bounds both the request and the refresh

buyButton.Activated:Connect(function()
    if state.requestId or not state.selectedId then
        return
    end
    state.requestId = HttpService:GenerateGUID(false)
    local myId = state.requestId -- token: only THIS purchase's timers act
    render()
    BuyItem:FireServer(myId, state.selectedId)

    -- Bound the pending state: silence can mean a lost request OR a
    -- committed purchase whose response never arrived.
    task.delay(REQUEST_TIMEOUT, function()
        -- Token check: if this purchase already resolved, or a NEWER
        -- purchase is now pending, this old timer must do nothing.
        if state.requestId ~= myId then
            return
        end
        statusLabel.Text = "Purchase outcome unknown. Refreshing..."
        RefreshPurchases:FireServer(myId) -- reconcile; never blind-retry
        -- Bound the refresh too: if no correlated answer arrives, stop the
        -- spinner but DO NOT discard the operation. The request id stays
        -- recorded and unresolved=true keeps Buy blocked, because the
        -- original purchase may still have committed, and a fresh same-intent
        -- purchase could double-spend. Reconciliation (a correlated
        -- PurchaseResult or echoed InventorySync) can still settle it.
        task.delay(REQUEST_TIMEOUT, function()
            if state.requestId == myId then
                state.unresolved = true
                statusLabel.Text = "Purchase outcome unknown. Check your inventory later."
                render()
            end
        end)
    end)
end)

PurchaseResult.OnClientEvent:Connect(function(id, ok, message)
    if id ~= state.requestId then
        return -- stale, duplicate, or already-reconciled result
    end
    state.requestId = nil
    state.unresolved = false
    statusLabel.Text = message
    render()
end)

-- Authoritative state wins, but only when it is actually NEWER than the
-- pending request: an unrelated background snapshot (fired before the
-- purchase committed) must not clear the pending state. The server echoes
-- the reconciled request id in the snapshot it sends in response to
-- RefreshPurchases; only that correlation settles a pending request,
-- including one already marked unresolved.
InventorySync.OnClientEvent:Connect(function(snapshot)
    if state.requestId then
        if snapshot.reconciledRequestId ~= state.requestId then
            return -- older or unrelated snapshot: leave the pending state alone
        end
        state.requestId = nil -- correlated reconciliation settles the request
        state.unresolved = false
    end
    statusLabel.Text = snapshot.ownsItem and "Purchased" or "Not purchased"
    render()
end)
```

Do not grant currency, inventory, or ownership because a local button handler ran. The UI is an input surface, not a trust boundary. Correlate each request with an id, treat "no response yet" as a bounded unknown rather than a failure to retry, and reconcile against authoritative server state: a timed-out purchase may still have committed, so a blind retry can double-spend. In Server Authority projects, the client may briefly render predicted state that is later corrected by rollback. Keep durable displays tied to confirmed server or synchronized state, and mark optimistic feedback as pending when the distinction matters.

## 7. Input and interaction

Use `Activated` for buttons when possible. Use `ContextActionService` for UI-only actions that should map across keyboard, gamepad, and touch. For gameplay-affecting input in a Server Authority project, use `InputAction`/`InputContext` and the synchronized simulation path. Use `UserInputService` when you need raw device details or gesture tracking.

Every interactive control needs:

- a visible state for hover, press, disabled, and focus where the platform supports it;
- a clear label or tooltip;
- a route that works without precise mouse aiming;
- a debounced action that cannot issue duplicate requests while busy.

### Reliable hover (MouseEnter/MouseLeave pitfalls)

Native `GuiObject.MouseEnter`/`MouseLeave` only re-check hover when the mouse moves, so they can miss when content scrolls under a stationary cursor (e.g. inside a `ScrollingFrame`) or occasionally fail to fire `MouseLeave`. For reliable hover, poll the cursor each frame and fire your own enter/leave on state transitions. This is a practitioner pattern (DevForum lead: "REAL MouseEnter/MouseLeave for GuiObjects", 7eoeb, https://devforum.roblox.com/t/real-mouseentermouseleave-for-guiobjects-they-actually-fire/3980310). Prefer `PlayerGui:GetGuiObjectsAtPosition()` over hardcoded top-bar offsets, and clean up the signals with the owning UI's lifetime.

The two coordinate spaces differ: `UserInputService:GetMouseLocation()` returns raw pixels that do **not** account for `Enum.ScreenInsets`, while `BasePlayerGui:GetGuiObjectsAtPosition()` expects x/y relative to the top-left corner **after** the GUI inset is applied (per its docs, see `GuiService:GetGuiInset()`). Convert by subtracting the top-left inset before the hit test — the example below documents that conversion, but the exact on-screen offset behavior (especially with `ScreenGui.IgnoreGuiInset = true`, top-bar variants, or mobile) has **not been live-verified in Studio**; illustrative only, verify against the real target layout before relying on it. Do not assume raw `GetMouseLocation()` coordinates are correct for `IgnoreGuiInset = true` ScreenGuis without measuring.

```luau
-- ILLUSTRATIVE: inset conversion not live-verified in Studio; see note above.
local Players = game:GetService("Players")
local RS = game:GetService("RunService")
local UIS = game:GetService("UserInputService")
local GuiService = game:GetService("GuiService")

local playerGui = Players.LocalPlayer:WaitForChild("PlayerGui")

local hovered = false
RS.RenderStepped:Connect(function()
    local pos = UIS:GetMouseLocation()
    -- GetGuiObjectsAtPosition expects inset-adjusted coordinates; subtract
    -- the top-left inset (first GetGuiInset return) before the hit test.
    local inset = GuiService:GetGuiInset()
    local isOver = false
    for _, obj in playerGui:GetGuiObjectsAtPosition(pos.X - inset.X, pos.Y - inset.Y) do
        if obj == frame then isOver = true break end
    end
    if isOver and not hovered then
        hovered = true
        onEnter()
    elseif not isOver and hovered then
        hovered = false
        onLeave()
    end
end)
```

## 8. Gamepad focus and selection

Gamepad support is not complete when a button merely reacts to `Activated`. The player also needs a predictable focus path:

```luau
local GuiService = game:GetService("GuiService")

playButton.Selectable = true
settingsButton.Selectable = true

-- Set this when opening the menu, not every frame.
GuiService.SelectedObject = playButton
```

For larger menus, group related controls and define explicit directional behavior where automatic selection is ambiguous. Test selection entering and leaving nested containers, covered elements, modal dialogs, and a changing list. Roblox's current directional-selection behavior includes ancestor grouping, covered-element handling, and improved analog-stick navigation. The official `focus-navigation` repository is a read-only mirror and is best treated as an optional reference rather than a mandatory dependency.

React Luau is another optional reference for state-driven, declarative UI. Do not introduce it into a small native UI merely to avoid writing a few render functions.

## 9. Animation and cleanup

Tween a small set of properties and cancel or replace the previous tween when state changes. Keep connections and tweens owned by the screen or row they affect. Destroy temporary UI when the owning feature closes.

```luau
local TweenService = game:GetService("TweenService")
local modal = screenGui.Modal -- CanvasGroup
local openTween = TweenService:Create(
    modal,
    TweenInfo.new(0.18, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
    { GroupTransparency = 0 }
)

openTween:Play()
```

If the object can be destroyed before the tween completes, connect cleanup to the owner's lifetime rather than assuming `Completed` will always run.

## Reactive UI libraries: scope, lifetime, and lists

Native instances (everything above) are the default. Some projects use a reactive UI library instead — [Fusion](https://elttob.uk/Fusion/0.3/) (dphfox/Fusion, 0.3 line), [Vide](https://github.com/centau/vide), [Fluid](https://github.com/ffrostfall/fluid) (Vide-derived, MIT, v0.6.5), or React-Luau. Follow the project's existing choice; do not introduce one into a native-UI project to avoid writing a few render functions. The rules below are library-neutral; the per-library notes were verified against each repo and its docs (2026-10).

### Two lifetimes: session state vs screen state

- Session-length state (player stats, settings, currency display) lives in a module created once per session. Screens consume it; they do not own it.
- Per-open UI (menus, shop, HUD screens) gets a fresh reactive scope/root each time it opens and is destroyed on close.
- Putting mutable game state inside a screen's scope destroys it on the first close. Putting screen widgets in a session/root scope leaks them.

### Who cleans up what (the differences are the decision)

- **Fusion (0.3):** every constructor registers a destructor into the scope you pass it, and scope cleanup (`doCleanup`) destroys contents in reverse order (docs: Scopes tutorial, `Computed` API). `Hydrate` inserts the target instance into the scope (verified in `src/Instances/Hydrate.luau`), so hydrating a designer-built instance means scope cleanup destroys it — clone the instance first if it must survive the scope.
- **Vide:** `cleanup()` accepts functions and supported destroy/disconnect resources, and runs it when the scope reruns or is destroyed. The docs state instances "do not need to be explicitly destroyed for their memory to be freed, they only need to be parented to `nil`", so instance teardown stays a manual idiom: a screen teardown should still unparent its root.
- **Fluid:** `root()`'s returned destructor tears down the reactive graph — cleanups, dependencies, child nodes — but does **not** destroy Instances created by `create()`; verified in fluid source (`src/reactive/root.luau`, `src/instances/create.luau` register no instance teardown). A screen opened in a loop leaks instances unless an explicit `cleanup(instance)` (which does call `:Destroy()`) or a manual unparent sits at the tree root.
- General rule for any library: name the single root teardown call per screen, and verify instances are actually removed on close.

### Derived state vs effects

- A value that is a pure function of other state should be derived (computed), not stored and written by three code paths that can drift.
- Conversely, do not wrap constants in reactive machinery.
- Side effects do not belong in derived computations. Fusion's docs state recalculations "might be postponed or cancelled if the value of the computed isn't being used" and warn against using computeds "for things like playing sound effects". Put side effects in explicit observers/effects (Fusion `Observer:onChange`/`:onBind`), and expect their callbacks to fire at surprising times — during scope teardown, before the tree is parented — a fatal-throw bug class.

### Keyed list rendering

- Per-entry scopes must be keyed by identity, not array position, or a reorder destroys and rebuilds rows that should have moved.
- Visible order must come from an explicit layout property (`LayoutOrder`); hash-map output ordering is arbitrary.
- Duplicate keys misbehave: Vide's `values()` errors on duplicate values under strict mode (`"table source passed to 'values()' contains duplicate values"`) and its docs warn duplicates "can cause unexpected behavior" otherwise. Deduplicate or index before rendering.
- Exit animations need an explicit leaving-grace (delayed destruction while the tween plays), not an ad-hoc debounce.

### The reopen leak test

Any screen that opens and closes should survive this checklist (original procedure):

1. Record the descendant count of the screen's container at baseline.
2. Open and close the screen 10 times in a loop.
3. Assert the count returns to baseline. A growing count means leaked instances; a growing connection count means leaked signals.
4. Repeat with the screen closed mid-animation and mid-network-response — the two states that expose teardown-order bugs.

Run it from the command bar or as an engine test (see roblox-tooling's test-runner doctrine). It is the reactive-library equivalent of the UI checklist rule that every temporary connection, tween, and row has an owner lifetime.

## 10. Shops, dialogs, and notifications

A practical UI flow is:

1. render a neutral/loading state;
2. load or receive the data model;
3. allow one action at a time per row or transaction;
4. show a success, failure, or retry state;
5. refresh from authoritative state after the action.

Do not close a purchase dialog merely because a prompt was opened. Wait for the purchase or server result, and handle cancellation.

## 11. Safe areas and cross-device review

Do not choose `ScreenGui.ScreenInsets`, `IgnoreGuiInset`, or `ClipToDeviceSafeArea` from a single Studio viewport. `Enum.ScreenInsets.CoreUISafeInsets` is one option, not a universal default. Test the actual target combinations and record which elements intentionally sit under or outside Roblox core UI.

Test at minimum:

- narrow phone portrait;
- wide phone or tablet landscape;
- desktop mouse/keyboard;
- gamepad navigation;
- console safe-area and top-bar behavior;
- mobile cutout/notch and on-screen keyboard behavior;
- a long localized string;
- a missing or delayed asset;
- respawn and UI reopening;
- low frame rate while a list is updating.

A layout that looks correct at one Studio viewport size is not finished. Capture the intended states and compare them after changing the viewport and preferred input.

## Custom loading flow

1. Create the replacement UI from a `LocalScript` in `ReplicatedFirst` before calling `RemoveDefaultLoadingScreen()`.
2. Treat `game:IsLoaded()` and `game.Loaded` as DataModel readiness, not proof that every asset is ready.
3. Use `ContentProvider:PreloadAsync()` only for a bounded critical set, with timeout and fallback behavior.
4. Gate controls and the first playable state explicitly. Do not move the character from the client as a loading lock.
5. Restore any changed controls, CoreGui state, camera state, and temporary connections on success, timeout, cancellation, and respawn.

## UI checklist

- [ ] Containers use layout objects and constraints instead of scattered pixel positions.
- [ ] Text growth, clipping, and scrolling have an explicit policy.
- [ ] Buttons expose disabled and busy states.
- [ ] UI actions are safe to repeat or are debounced.
- [ ] Server responses, not local optimism, determine durable state.
- [ ] The interface works with touch, mouse, keyboard, and gamepad where relevant.
- [ ] All temporary connections, tweens, and rows have an owner lifetime.

## Existing style and visual verification

Follow the project's existing components, typography roles, colors, spacing, and interaction states. Do not impose a genre palette or invent a new design system for one screen. A new screen or a restyle takes its visual composition from `roblox-ui-design`; a working instance tree is not proof that the UI looks right.

Test the actual screen over bright and dark game scenes, not only a blank Studio canvas. Check clipping, contrast, gameplay visibility, and the rendered states that exist (such as active, selected, disabled, or purchase pending). Hover is not available on every input device; focus and touch must still work. Check `GuiService.ReducedMotionEnabled` before adding motion-heavy feedback. Layout and accessibility are engineering checks, not a prescribed visual style.

## Shared styling and flex, when needed

For an existing stylesheet-based project, extend its tokens and rules rather than setting conflicting per-instance properties. Roblox `StyleSheet` rules are attached to a UI tree with `StyleLink`; `StyleQuery` can adapt to size, preferred input, text size, or reduced motion. For a one-off UI, direct properties may be simpler. See the [official styling guide](https://create.roblox.com/docs/ui/styling) before adding a new sheet.

Flex is built into `UIListLayout` (`HorizontalFlex` or `VerticalFlex`); `UIFlexItem` customizes a child. There is no `UIFlexLayout` instance. Use it only when a row or column needs flexible space; otherwise ordinary list/grid layout is simpler. If items spread apart unexpectedly, inspect the layout's flex alignment before adding offsets. Keep `SortOrder = LayoutOrder` and set each child's `LayoutOrder` when order matters. See the [official list/flex guide](https://create.roblox.com/docs/ui/list-flex-layouts).

## Community ecosystem (leads, not sources)

Top-sorted DevForum canon for UI libraries. Verify status in-thread before recommending.

- [TopbarPlus v3](https://devforum.roblox.com/t/topbarplus-v340-construct-topbar-icons-with-ease-customise-them-with-themes-dropdowns-captions-labels-and-more/1017485): the topbar icon standard (4.4k likes).
- [Iris](https://devforum.roblox.com/t/iris-immediate-mode-ui-library-based-on-dear-imgui/2302802): Dear ImGui-style immediate mode, good for debug tools/dev UIs, not player-facing polish.
- [Screen3D](https://devforum.roblox.com/t/screen3d-a-3d-ui-framework-that-just-works/3273671) (2024); [Text+](https://devforum.roblox.com/t/text-custom-fonts-advanced-control/3521684) (2025) custom fonts.
- [Satchel](https://devforum.roblox.com/t/satchel-open-source-modern-backpack-system/2451549): open-source inventory/backpack, study-grade.
- [Vanilla 3](https://devforum.roblox.com/t/vanilla-3-the-pragmatic-icon-set-for-roblox-studio/935745): the pragmatic icon set.
- Chat: BetterChat V3 discontinued; [NovaChat](https://devforum.roblox.com/t/novachat-v107-chat-update-part-2-a-modern-feature-rich-chat-replacement-update/4513813) (2026) is the active replacement line; [ViewportFrame masking](https://devforum.roblox.com/t/viewportframe-masking/2964839) (2024) heavily cited for UI VFX.
- Design theory: [UI Design Starter Guide](https://devforum.roblox.com/t/ui-design-starter-guide/53461) (1.1k likes).
- [Mobile button placement tutorial](https://devforum.roblox.com/t/the-correct-way-to-design-mobile-buttons/2494558) illustrates collisions with the default thumbstick/jump controls and touchscreen-PC detection pitfalls. Treat its coordinates and per-frame script as dated examples, not a portable recipe; test on the game's target devices.

## Pagination (UIPageLayout)

A `UIPageLayout` parented to a `GuiObject` (usually a `Frame`) stacks its children as full-size pages; only the current page is visible. Members: `JumpTo(page)`, `JumpToIndex(index)`, `Next()`, `Previous()`, plus the `CurrentPage` property. Set `Circular = true` for wraparound looping and tune motion with `TweenTime`, `EasingStyle`, `EasingDirection` (`Animated = false` for instant snaps). The layout provides no buttons, so wire input yourself:

```luau
local layout = Instance.new("UIPageLayout")
layout.TweenTime = 0.25
layout.EasingStyle = Enum.EasingStyle.Quad
layout.Parent = pageContainer

nextButton.Activated:Connect(function() layout:Next() end)
prevButton.Activated:Connect(function() layout:Previous() end)
layout.PageEnter:Connect(function(page)
    updateDots(page) -- one dot per child; highlight CurrentPage
end)
```

`PageEnter`/`PageLeave` fire on page transitions and `Stopped` when a tween settles; that is the hook for a page-indicator/paginator pattern. `ScrollWheelInputEnabled`, `TouchInputEnabled`, and `GamepadInputEnabled` control the built-in pan input.

## Selection outlines (SelectionBox)

`SelectionBox` renders a 3D box outline around its `Adornee` (inherited from `InstanceAdornment`); it is purely visual and captures no input. Style with `LineThickness` (studs), `Color3` (outline color, from `GuiBase3d`), and `SurfaceColor3`/`SurfaceTransparency` (faces; surface transparency defaults to 1). Prefer the `Highlight` class when you need fill/outline effects over non-primitive geometry such as `MeshPart`.

```luau
local box = Instance.new("SelectionBox")
box.LineThickness = 0.05
box.Color3 = Color3.new(1, 1, 0)
box.SurfaceTransparency = 1
box.Parent = workspace

local mouse = Players.LocalPlayer:GetMouse()
mouse.Move:Connect(function()
    box.Adornee = mouse.Target -- nil when pointing at nothing
end)
```

## Decals (Decal, Texture)

`Decal` draws a single image on one face of a part (`Face = Enum.NormalId.Front`, etc.). The separate `Texture` class shares face placement and repeats/tiles the image via `StudsPerTileU/V` and `OffsetStudsU/V`; use `Texture` for tiled surfaces and `Decal` for posters and signs. The image property `Texture` (ContentId) is deprecated in favor of `ColorMap`/`ColorMapContent` but still functional. `Transparency`, `Color3`, and `Face` are runtime-writable: tween decals, or swap images in response to gameplay. User-uploaded image assets go through moderation; a failed review renders nothing, so ship a placeholder and handle it.

```luau
local decal = Instance.new("Decal")
decal.Face = Enum.NormalId.Front
decal.Texture = "rbxassetid://699259085"
decal.Parent = part
```

## Video (VideoFrame, VideoPlayer)

`VideoFrame` is the simple path: parent it to a `SurfaceGui` and set `Video` (ContentId) to a video-type asset; image IDs will not play. Control with `Play()`, `Pause()`, `Looped`, and `Volume`; wait for `IsLoaded` (or the `Loaded` event) before playing. `Ended`/`DidLoop` report playback progress.

`VideoPlayer` is the newer wire-based source: set `VideoContent` (Content), then connect `Wire` instances to a `VideoDisplay` inside a `SurfaceGui` for visuals and an `AudioEmitter` for sound. It adds `PlaybackSpeed`, `TimePosition`, `LoadAsync()`, and a `PlayFailed` event for fetch failures. Prefer `VideoFrame` unless you need the video/audio wire split.

```luau
local gui = Instance.new("SurfaceGui")
gui.Parent = screenPart

local video = Instance.new("VideoFrame")
video.Size = UDim2.fromScale(1, 1)
video.Looped = true
video.Video = "rbxassetid://5608359401"
video.Parent = gui

if not video.IsLoaded then
    video.Loaded:Wait()
end
video:Play()
```

import { TweenService } from "@rbxts/services";
import State from "./State";
import ServerUrlSettings from "./ServerUrlSettings";

interface UIElements {
	screenGui: DockWidgetPluginGui;
	mainFrame: Frame;
	contentFrame: ScrollingFrame;
	statusLabel: TextLabel;
	detailStatusLabel: TextLabel;
	statusIndicator: Frame;
	connectButton: TextButton;
	connectStroke: UIStroke;
	urlInput: TextBox;
	troubleshootLabel: TextLabel;
	updateBanner: Frame;
	updateBannerText: TextLabel;
}

let elements: UIElements = undefined!;
let buttonHover = false;
let activeBannerKind: string | undefined;

interface ToolbarIcons {
	disconnected: string;
	connecting: string;
	connected: string;
}

let toolbarButton: PluginToolbarButton | undefined;
let toolbarIcons: ToolbarIcons | undefined;
let lastToolbarIcon: string | undefined;

function setToolbarButton(btn: PluginToolbarButton, icons: ToolbarIcons) {
	toolbarButton = btn;
	toolbarIcons = icons;
	lastToolbarIcon = undefined;
	updateToolbarIcon();
}

function updateToolbarIcon() {
	if (!toolbarButton || !toolbarIcons) return;
	const conn = State.getActiveConnection();
	const nextIcon = !conn || !conn.isActive
		? toolbarIcons.disconnected
		: conn.lastHttpOk && conn.lastMcpOk
			? toolbarIcons.connected
			: toolbarIcons.connecting;
	if (nextIcon === lastToolbarIcon) return;
	(toolbarButton as unknown as { Icon: string }).Icon = nextIcon;
	lastToolbarIcon = nextIcon;
}

const C = {
	canvas: Color3.fromRGB(21, 23, 27),
	surface: Color3.fromRGB(33, 36, 43),
	sunken: Color3.fromRGB(17, 19, 24),
	border: Color3.fromRGB(52, 57, 67),
	ink: Color3.fromRGB(237, 240, 244),
	inkSecondary: Color3.fromRGB(194, 199, 208),
	muted: Color3.fromRGB(146, 153, 165),
	faint: Color3.fromRGB(104, 113, 126),
	action: Color3.fromRGB(221, 225, 231),
	actionHover: Color3.fromRGB(240, 242, 245),
	actionInk: Color3.fromRGB(26, 29, 34),
	accent: Color3.fromRGB(154, 163, 255),
	green: Color3.fromRGB(112, 189, 136),
	yellow: Color3.fromRGB(210, 164, 81),
	yellowSoft: Color3.fromRGB(45, 40, 29),
	red: Color3.fromRGB(223, 133, 130),
	redSoft: Color3.fromRGB(51, 35, 33),
};

// Substituted at build time from the same id the toolbar button uses; empty
// until the mark is published, in which case the panel draws a letter instead.
const BRAND_MARK_ASSET_ID: string = "__BRAND_MARK_ASSET_ID__";

const CORNER = new UDim(0, 8);
const TWEEN_QUICK = new TweenInfo(0.15, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);

function tweenProp(instance: Instance, props: Record<string, unknown>) {
	TweenService.Create(instance, TWEEN_QUICK, props as unknown as { [key: string]: unknown }).Play();
}

function showBanner(kind: string, text: string) {
	activeBannerKind = kind;
	elements.updateBannerText.Text = text;
	elements.updateBanner.Visible = true;
	elements.contentFrame.Position = new UDim2(0, 16, 0, 108);
	elements.contentFrame.Size = new UDim2(1, -32, 1, -120);
}

function hideBanner(kind?: string) {
	if (kind !== undefined && activeBannerKind !== kind) return;
	activeBannerKind = undefined;
	elements.updateBanner.Visible = false;
	elements.updateBannerText.Text = "";
	elements.contentFrame.Position = new UDim2(0, 16, 0, 72);
	elements.contentFrame.Size = new UDim2(1, -32, 1, -84);
}

function setButtonConnect(btn: TextButton, stroke: UIStroke) {
	btn.Text = "Connect";
	btn.TextColor3 = C.actionInk;
	btn.BackgroundColor3 = C.action;
	stroke.Color = C.action;
}

function setButtonDisconnect(btn: TextButton, stroke: UIStroke) {
	btn.Text = "Disconnect";
	btn.TextColor3 = C.ink;
	btn.BackgroundColor3 = C.redSoft;
	stroke.Color = Color3.fromRGB(91, 57, 55);
}

function setStatus(label: string, detail: string, color: Color3) {
	elements.statusLabel.Text = label;
	elements.statusLabel.TextColor3 = color;
	elements.detailStatusLabel.Text = detail;
	elements.detailStatusLabel.TextColor3 = color === C.muted ? C.faint : color;
	elements.statusIndicator.BackgroundColor3 = color;
}

function init(pluginRef: Plugin) {
	const currentVersion = State.CURRENT_VERSION;
	const isInspector = State.PLUGIN_VARIANT === "inspector";
	const productName = isInspector ? "Roqer Inspector" : "Roqer";

	const screenGui = pluginRef.CreateDockWidgetPluginGuiAsync(
		"MCPServerInterface",
		// Keep the existing id so users retain their saved dock position.
		new DockWidgetPluginGuiInfo(Enum.InitialDockState.Float, false, true, 300, 250, 260, 220),
	);
	(screenGui as unknown as { Title: string }).Title = productName;

	const mainFrame = new Instance("Frame");
	mainFrame.Size = new UDim2(1, 0, 1, 0);
	mainFrame.BackgroundColor3 = C.canvas;
	mainFrame.BorderSizePixel = 0;
	mainFrame.Parent = screenGui;

	const header = new Instance("Frame");
	header.Size = new UDim2(1, 0, 0, 62);
	header.BackgroundTransparency = 1;
	header.Parent = mainFrame;

	if (BRAND_MARK_ASSET_ID !== "") {
		// The published mark carries its own rounded dark tile, so nothing is
		// drawn behind it.
		const brandImage = new Instance("ImageLabel");
		brandImage.Size = new UDim2(0, 34, 0, 34);
		brandImage.Position = new UDim2(0, 16, 0, 14);
		brandImage.BackgroundTransparency = 1;
		brandImage.Image = `rbxassetid://${BRAND_MARK_ASSET_ID}`;
		brandImage.ScaleType = Enum.ScaleType.Fit;
		brandImage.Parent = header;
	} else {
		const brandMark = new Instance("Frame");
		brandMark.Size = new UDim2(0, 34, 0, 34);
		brandMark.Position = new UDim2(0, 16, 0, 14);
		brandMark.BackgroundColor3 = C.surface;
		brandMark.BorderSizePixel = 0;
		brandMark.Parent = header;

		const brandCorner = new Instance("UICorner");
		brandCorner.CornerRadius = new UDim(0, 9);
		brandCorner.Parent = brandMark;

		const brandStroke = new Instance("UIStroke");
		brandStroke.Color = C.border;
		brandStroke.Thickness = 1;
		brandStroke.Parent = brandMark;

		const brandLetter = new Instance("TextLabel");
		brandLetter.Size = new UDim2(1, 0, 1, 0);
		brandLetter.BackgroundTransparency = 1;
		brandLetter.Text = "R";
		brandLetter.TextColor3 = C.accent;
		brandLetter.TextSize = 20;
		brandLetter.Font = Enum.Font.GothamBold;
		brandLetter.Parent = brandMark;
	}

	const titleLabel = new Instance("TextLabel");
	titleLabel.Size = new UDim2(1, -78, 0, 20);
	titleLabel.Position = new UDim2(0, 62, 0, 13);
	titleLabel.BackgroundTransparency = 1;
	titleLabel.Text = productName;
	titleLabel.TextColor3 = C.ink;
	titleLabel.TextSize = 15;
	titleLabel.Font = Enum.Font.GothamBold;
	titleLabel.TextXAlignment = Enum.TextXAlignment.Left;
	titleLabel.Parent = header;

	const subtitleLabel = new Instance("TextLabel");
	subtitleLabel.Size = new UDim2(1, -78, 0, 15);
	subtitleLabel.Position = new UDim2(0, 62, 0, 33);
	subtitleLabel.BackgroundTransparency = 1;
	subtitleLabel.Text = `${isInspector ? "Read-only bridge" : "Studio bridge"}  ·  v${currentVersion}`;
	subtitleLabel.TextColor3 = C.muted;
	subtitleLabel.TextSize = 9;
	subtitleLabel.Font = Enum.Font.GothamMedium;
	subtitleLabel.TextXAlignment = Enum.TextXAlignment.Left;
	subtitleLabel.Parent = header;

	const updateBanner = new Instance("Frame");
	updateBanner.Size = new UDim2(1, -32, 0, 28);
	updateBanner.Position = new UDim2(0, 16, 0, 70);
	updateBanner.BackgroundColor3 = C.yellowSoft;
	updateBanner.BorderSizePixel = 0;
	updateBanner.Visible = false;
	updateBanner.Parent = mainFrame;

	const updateBannerCorner = new Instance("UICorner");
	updateBannerCorner.CornerRadius = CORNER;
	updateBannerCorner.Parent = updateBanner;

	const updateBannerText = new Instance("TextLabel");
	updateBannerText.Size = new UDim2(1, -16, 1, 0);
	updateBannerText.Position = new UDim2(0, 8, 0, 0);
	updateBannerText.BackgroundTransparency = 1;
	updateBannerText.Text = "";
	updateBannerText.TextColor3 = C.yellow;
	updateBannerText.TextSize = 9;
	updateBannerText.Font = Enum.Font.GothamMedium;
	updateBannerText.TextXAlignment = Enum.TextXAlignment.Left;
	updateBannerText.Parent = updateBanner;

	const contentFrame = new Instance("ScrollingFrame");
	contentFrame.Size = new UDim2(1, -32, 1, -84);
	contentFrame.Position = new UDim2(0, 16, 0, 72);
	contentFrame.BackgroundTransparency = 1;
	contentFrame.BorderSizePixel = 0;
	contentFrame.ScrollBarThickness = 2;
	contentFrame.ScrollBarImageColor3 = C.faint;
	contentFrame.CanvasSize = new UDim2(0, 0, 0, 0);
	contentFrame.AutomaticCanvasSize = Enum.AutomaticSize.Y;
	contentFrame.Parent = mainFrame;

	const contentLayout = new Instance("UIListLayout");
	contentLayout.Padding = new UDim(0, 10);
	contentLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	contentLayout.Parent = contentFrame;

	const connectionRow = new Instance("Frame");
	connectionRow.Size = new UDim2(1, 0, 0, 40);
	connectionRow.BackgroundTransparency = 1;
	connectionRow.LayoutOrder = 1;
	connectionRow.Parent = contentFrame;

	const connectButton = new Instance("TextButton");
	connectButton.Size = new UDim2(0, 104, 0, 34);
	connectButton.Position = new UDim2(0, 0, 0, 2);
	connectButton.BackgroundColor3 = C.action;
	connectButton.BorderSizePixel = 0;
	connectButton.Text = "Connect";
	connectButton.TextColor3 = C.actionInk;
	connectButton.TextSize = 11;
	connectButton.Font = Enum.Font.GothamBold;
	connectButton.Parent = connectionRow;

	const connectCorner = new Instance("UICorner");
	connectCorner.CornerRadius = CORNER;
	connectCorner.Parent = connectButton;

	const connectStroke = new Instance("UIStroke");
	connectStroke.Color = C.action;
	connectStroke.Thickness = 1;
	connectStroke.Parent = connectButton;

	const statusIndicator = new Instance("Frame");
	statusIndicator.Size = new UDim2(0, 7, 0, 7);
	statusIndicator.Position = new UDim2(0, 120, 0, 7);
	statusIndicator.BackgroundColor3 = C.faint;
	statusIndicator.BorderSizePixel = 0;
	statusIndicator.Parent = connectionRow;

	const statusCorner = new Instance("UICorner");
	statusCorner.CornerRadius = new UDim(1, 0);
	statusCorner.Parent = statusIndicator;

	const statusLabel = new Instance("TextLabel");
	statusLabel.Size = new UDim2(1, -137, 0, 17);
	statusLabel.Position = new UDim2(0, 137, 0, 1);
	statusLabel.BackgroundTransparency = 1;
	statusLabel.Text = "Not connected";
	statusLabel.TextColor3 = C.muted;
	statusLabel.TextSize = 10;
	statusLabel.Font = Enum.Font.GothamBold;
	statusLabel.TextXAlignment = Enum.TextXAlignment.Left;
	statusLabel.TextTruncate = Enum.TextTruncate.AtEnd;
	statusLabel.Parent = connectionRow;

	const detailStatusLabel = new Instance("TextLabel");
	detailStatusLabel.Size = new UDim2(1, -120, 0, 15);
	detailStatusLabel.Position = new UDim2(0, 120, 0, 20);
	detailStatusLabel.BackgroundTransparency = 1;
	detailStatusLabel.Text = "Open Roqer to begin";
	detailStatusLabel.TextColor3 = C.faint;
	detailStatusLabel.TextSize = 9;
	detailStatusLabel.Font = Enum.Font.GothamMedium;
	detailStatusLabel.TextXAlignment = Enum.TextXAlignment.Left;
	detailStatusLabel.TextTruncate = Enum.TextTruncate.AtEnd;
	detailStatusLabel.Parent = connectionRow;

	const addressLabel = new Instance("TextLabel");
	addressLabel.Size = new UDim2(1, 0, 0, 13);
	addressLabel.BackgroundTransparency = 1;
	addressLabel.Text = "BRIDGE ADDRESS";
	addressLabel.TextColor3 = C.faint;
	addressLabel.TextSize = 8;
	addressLabel.Font = Enum.Font.GothamBold;
	addressLabel.TextXAlignment = Enum.TextXAlignment.Left;
	addressLabel.LayoutOrder = 2;
	addressLabel.Parent = contentFrame;

	const urlInput = new Instance("TextBox");
	urlInput.Size = new UDim2(1, 0, 0, 34);
	urlInput.BackgroundColor3 = C.sunken;
	urlInput.BorderSizePixel = 0;
	urlInput.Text = State.getActiveConnection().serverUrl;
	urlInput.TextColor3 = C.inkSecondary;
	urlInput.TextSize = 10;
	urlInput.Font = Enum.Font.GothamMedium;
	urlInput.ClearTextOnFocus = false;
	urlInput.PlaceholderText = State.defaultServerUrl(State.BASE_PORT);
	urlInput.PlaceholderColor3 = C.muted;
	urlInput.LayoutOrder = 3;
	urlInput.Parent = contentFrame;

	const urlCorner = new Instance("UICorner");
	urlCorner.CornerRadius = CORNER;
	urlCorner.Parent = urlInput;

	const urlStroke = new Instance("UIStroke");
	urlStroke.Color = C.border;
	urlStroke.Thickness = 1;
	urlStroke.Parent = urlInput;

	const urlPadding = new Instance("UIPadding");
	urlPadding.PaddingLeft = new UDim(0, 10);
	urlPadding.PaddingRight = new UDim(0, 10);
	urlPadding.Parent = urlInput;

	urlInput.FocusLost.Connect(() => {
		const conn = State.getActiveConnection();
		if (!conn || conn.isActive) return;
		const normalizedUrl = ServerUrlSettings.normalizeServerUrl(urlInput.Text);
		if (normalizedUrl === "") {
			urlInput.Text = conn.serverUrl;
			return;
		}
		conn.serverUrl = normalizedUrl;
		urlInput.Text = normalizedUrl;
		const port = ServerUrlSettings.extractPort(conn.serverUrl);
		if (port !== undefined) conn.port = port;
	});

	// Sized by its text: a reason can run to two or three lines, and a fixed
	// height would clip exactly the part worth reading.
	const troubleshootLabel = new Instance("TextLabel");
	troubleshootLabel.Size = new UDim2(1, 0, 0, 0);
	troubleshootLabel.AutomaticSize = Enum.AutomaticSize.Y;
	troubleshootLabel.BackgroundTransparency = 1;
	troubleshootLabel.TextWrapped = true;
	troubleshootLabel.TextYAlignment = Enum.TextYAlignment.Top;
	troubleshootLabel.Visible = false;
	troubleshootLabel.Text = "";
	troubleshootLabel.TextColor3 = C.yellow;
	troubleshootLabel.TextSize = 9;
	troubleshootLabel.Font = Enum.Font.GothamMedium;
	troubleshootLabel.TextXAlignment = Enum.TextXAlignment.Left;
	troubleshootLabel.LayoutOrder = 4;
	troubleshootLabel.Parent = contentFrame;

	const localNote = new Instance("TextLabel");
	localNote.Size = new UDim2(1, 0, 0, 15);
	localNote.BackgroundTransparency = 1;
	localNote.Text = isInspector ? "Read-only access to this Studio session" : "Linked locally through the Roqer desktop app";
	localNote.TextColor3 = C.faint;
	localNote.TextSize = 8;
	localNote.Font = Enum.Font.GothamMedium;
	localNote.TextXAlignment = Enum.TextXAlignment.Left;
	localNote.LayoutOrder = 5;
	localNote.Parent = contentFrame;

	connectButton.MouseEnter.Connect(() => {
		buttonHover = true;
		const conn = State.getActiveConnection();
		if (conn && conn.isActive) {
			tweenProp(connectButton, { BackgroundColor3: Color3.fromRGB(61, 40, 38) });
			tweenProp(connectStroke, { Color: C.red });
		} else {
			tweenProp(connectButton, { BackgroundColor3: C.actionHover });
			tweenProp(connectStroke, { Color: C.actionHover });
		}
	});

	connectButton.MouseLeave.Connect(() => {
		buttonHover = false;
		const conn = State.getActiveConnection();
		if (conn && conn.isActive) setButtonDisconnect(connectButton, connectStroke);
		else setButtonConnect(connectButton, connectStroke);
	});

	elements = {
		screenGui,
		mainFrame,
		contentFrame,
		statusLabel,
		detailStatusLabel,
		statusIndicator,
		connectButton,
		connectStroke,
		urlInput,
		troubleshootLabel,
		updateBanner,
		updateBannerText,
	};
}

const MAX_RAW_REASON_CHARS = 160;

interface TransportReading {
	/** A few words for the status row. */
	short: string;
	/** What the person should do or know, in one line. */
	explanation: string;
	/** True when the cause is deterministic and waiting will not change it. */
	urgent: boolean;
}

/**
 * What the transport's failure detail means to the person reading the panel.
 *
 * The transport already knows why it failed -- a status, a silence, a refused
 * connection -- and used to tell the person only "Check that Roqer is open",
 * which sent them to the wrong place for every cause but one. A version
 * mismatch after an app update is the clearest case: Roqer is open, and the
 * only fix is restarting Studio.
 */
function readTransportDetail(detail: string | undefined, serverUrl: string): TransportReading | undefined {
	if (detail === undefined) return undefined;
	if (detail.find("HTTP 426")[0] !== undefined) {
		return {
			short: "Older plugin loaded",
			explanation: "Studio is running an older Roqer plugin. Close and reopen Studio to load the new one.",
			urgent: true,
		};
	}
	if (detail.find("HTTP 404")[0] !== undefined || detail.find("not registered")[0] !== undefined) {
		return { short: "Bridge restarted", explanation: "The bridge restarted. Reconnecting.", urgent: false };
	}
	if (detail.find("silent for")[0] !== undefined) {
		return {
			short: "Connection went quiet",
			explanation: "The connection went quiet without closing. Antivirus web shields can hold it like this.",
			urgent: false,
		};
	}
	if (detail.find("HTTP 5")[0] !== undefined) {
		return { short: "Bridge error", explanation: "The bridge answered with an error.", urgent: false };
	}
	if (
		detail.find("Timedout")[0] !== undefined ||
		detail.find("ConnectFail")[0] !== undefined ||
		detail.find("RequestAsync threw")[0] !== undefined ||
		detail.find("Failed to create event stream")[0] !== undefined ||
		detail.find("Event stream closed")[0] !== undefined
	) {
		return {
			short: "Nothing answered",
			explanation: `Nothing answered at ${serverUrl}. Roqer may be closed, or another program may own the port.`,
			urgent: false,
		};
	}
	return undefined;
}

function showTroubleshoot(text: string, color: Color3) {
	elements.troubleshootLabel.Text = text;
	elements.troubleshootLabel.TextColor3 = color;
	elements.troubleshootLabel.Visible = true;
}

function hideTroubleshoot() {
	elements.troubleshootLabel.Visible = false;
}

function updateUIState() {
	updateToolbarIcon();
	const conn = State.getActiveConnection();
	if (!conn) return;

	if (!conn.isActive) {
		setStatus("Not connected", "Open Roqer to begin", C.muted);
		hideTroubleshoot();
		if (!buttonHover) setButtonConnect(elements.connectButton, elements.connectStroke);
		elements.urlInput.TextEditable = true;
		elements.urlInput.BackgroundColor3 = C.sunken;
		return;
	}

	if (!buttonHover) setButtonDisconnect(elements.connectButton, elements.connectStroke);
	elements.urlInput.TextEditable = false;
	elements.urlInput.BackgroundColor3 = C.surface;

	const reading = readTransportDetail(conn.lastTransportDetail, conn.serverUrl);
	const rawReason = conn.lastTransportDetail === undefined
		? undefined
		: conn.lastTransportDetail.size() > MAX_RAW_REASON_CHARS
			? `${conn.lastTransportDetail.sub(1, MAX_RAW_REASON_CHARS - 1)}…`
			: conn.lastTransportDetail;

	if (conn.lastHttpOk && conn.lastMcpOk) {
		setStatus("Connected", "Ready for Studio tasks", C.green);
		hideTroubleshoot();
	} else if (conn.lastHttpOk && !conn.lastMcpOk) {
		setStatus("Connected", "Waiting for Roqer agent", C.yellow);
		const elapsed = conn.mcpWaitStartTime !== undefined ? tick() - conn.mcpWaitStartTime : 0;
		if (elapsed > 8) showTroubleshoot("Roqer's agent bridge is not ready. Restart Roqer and try again.", C.yellow);
		else hideTroubleshoot();
	} else if (reading !== undefined && reading.urgent) {
		// Deterministic: no number of retries will change it, so it is said now
		// rather than after fifty failed attempts.
		setStatus("Restart Studio", "Roqer updated the plugin while Studio was open", C.yellow);
		showTroubleshoot(reading.explanation, C.yellow);
	} else if (conn.consecutiveFailures >= conn.maxFailuresBeforeError) {
		setStatus("Unavailable", reading?.short ?? "Check that Roqer is open", C.red);
		const lines = [
			...(reading === undefined ? [] : [reading.explanation]),
			...(rawReason === undefined ? [] : [`Last error: ${rawReason}`]),
		];
		if (lines.size() > 0) showTroubleshoot(lines.join("\n"), C.red);
		else hideTroubleshoot();
	} else if (conn.consecutiveFailures > 5) {
		setStatus("Reconnecting", `Trying again in ${math.ceil(conn.currentRetryDelay)}s`, C.yellow);
		if (reading !== undefined) showTroubleshoot(reading.explanation, C.yellow);
		else hideTroubleshoot();
	} else {
		setStatus("Connecting", "Finding Roqer", C.yellow);
		hideTroubleshoot();
	}
}

export = {
	elements: undefined as unknown as UIElements,
	init,
	updateUIState,
	setToolbarButton,
	updateToolbarIcon,
	showBanner,
	hideBanner,
	getElements: () => elements,
};

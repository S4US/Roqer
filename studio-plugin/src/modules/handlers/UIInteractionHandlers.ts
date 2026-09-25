import InputHandlers from "./InputHandlers";
import UISemantics from "../UISemantics";

const SUPPORTED_ACTIONS = new Set<string>([
	"click",
	"focus",
	"type",
	"scroll_into_view",
	"set_scroll",
]);

function requestError(code: string, message: string): Record<string, unknown> {
	return { success: false, errorCode: code, error: code, message };
}

function compactCandidates(candidates: Instance[], playerGui: PlayerGui): Record<string, unknown>[] {
	const compact: Record<string, unknown>[] = [];
	for (let i = 0; i < math.min(candidates.size(), 10); i++) {
		compact.push(UISemantics.compactUiTarget(candidates[i], playerGui));
	}
	return compact;
}

function actionabilityError(
	target: Instance,
	playerGui: PlayerGui,
	reason: string,
): Record<string, unknown> {
	return {
		success: false,
		errorCode: "ui_target_not_actionable",
		error: "ui_target_not_actionable",
		message: `The selected UI target cannot perform this action: ${reason}.`,
		reason,
		resolved_target: UISemantics.compactUiTarget(target, playerGui),
	};
}

function interactionPoints(state: Record<string, unknown>): Record<string, Record<string, number>> | undefined {
	const interactionPoint = state.interactionPoint;
	let semanticPoint: Record<string, unknown> | undefined;
	if (typeIs(interactionPoint, "table")) {
		semanticPoint = interactionPoint as Record<string, unknown>;
	} else if (typeIs(state.visibleBounds, "table")) {
		const bounds = state.visibleBounds as Record<string, unknown>;
		if (typeIs(bounds.x, "number") && typeIs(bounds.y, "number") &&
			typeIs(bounds.width, "number") && typeIs(bounds.height, "number")) {
			semanticPoint = {
				x: bounds.x + bounds.width / 2,
				y: bounds.y + bounds.height / 2,
			};
		}
	}
	if (!semanticPoint || !typeIs(semanticPoint.x, "number") || !typeIs(semanticPoint.y, "number")) return undefined;
	return {
		semanticPoint: { x: semanticPoint.x, y: semanticPoint.y },
		inputPoint: UISemantics.guiPointToWindowPoint(semanticPoint as Record<string, number>),
	};
}

function runRealInput(
	action: string,
	target: Instance,
	playerGui: PlayerGui,
	requestData: Record<string, unknown>,
): Record<string, unknown> {
	const state = UISemantics.getUiTargetState(target, playerGui);
	if (state.actionable !== true) return actionabilityError(target, playerGui, tostring(state.reason ?? "not_actionable"));

	if (action === "click" && !target.IsA("GuiButton") && !target.IsA("TextBox")) {
		return actionabilityError(target, playerGui, "click_requires_button_or_text_box");
	}
	if ((action === "focus" || action === "type") && !target.IsA("TextBox")) {
		return actionabilityError(target, playerGui, "focus_and_type_require_text_box");
	}
	const text = requestData.text;
	if (action === "type" && !typeIs(text, "string")) {
		return requestError("invalid_ui_request", "type requires a string text value.");
	}

	const points = interactionPoints(state);
	if (!points) return actionabilityError(target, playerGui, "invalid_visible_bounds");
	const input = InputHandlers.simulateMouseInput({
		action: "click",
		x: points.inputPoint.x,
		y: points.inputPoint.y,
	});
	if (input.success !== true) {
		return requestError("ui_input_failed", `Mouse input failed: ${tostring(input.error)}`);
	}

	if (action === "type") {
		const keyboard = InputHandlers.simulateKeyboardInput({ text: text as string });
		if (keyboard.success !== true) {
			return requestError("ui_input_failed", `Keyboard input failed: ${tostring(keyboard.error)}`);
		}
	}

	return {
		success: true,
		action,
		interaction_mode: "real_input",
		resolved_target: UISemantics.compactUiTarget(target, playerGui),
		semantic_point: points.semanticPoint,
		input_point: points.inputPoint,
	};
}

function numberField(value: unknown, key: string): number | undefined {
	if (!typeIs(value, "table")) return undefined;
	const record = value as Record<string, unknown>;
	return typeIs(record[key], "number") ? record[key] : undefined;
}

function runScrollAction(
	action: string,
	target: Instance,
	playerGui: PlayerGui,
	requestData: Record<string, unknown>,
): Record<string, unknown> {
	if (action === "scroll_into_view") {
		const result = UISemantics.scrollInstanceIntoView(target, playerGui);
		if (result.success !== true) {
			return actionabilityError(target, playerGui, tostring(result.error ?? "scroll_into_view_failed"));
		}
		return {
			success: true,
			action,
			interaction_mode: "test_helper",
			resolved_target: UISemantics.compactUiTarget(target, playerGui),
			canvas_position: result.canvasPosition,
			max_canvas_position: result.maxCanvasPosition,
			scrolling_frame: result.scrollingFrame,
			revealed: result.revealed,
		};
	}

	if (!target.IsA("ScrollingFrame")) {
		return actionabilityError(target, playerGui, "set_scroll_requires_scrolling_frame");
	}
	const rawPosition = requestData.canvas_position ?? requestData.canvasPosition;
	const x = numberField(rawPosition, "x");
	const y = numberField(rawPosition, "y");
	if (x === undefined || y === undefined) {
		return requestError("invalid_ui_request", "set_scroll requires canvas_position with numeric x and y.");
	}
	const result = UISemantics.setScrollingFramePosition(target, x, y);
	if (result.success !== true) {
		return actionabilityError(target, playerGui, tostring(result.error ?? "set_scroll_failed"));
	}
	return {
		success: true,
		action,
		interaction_mode: "test_helper",
		resolved_target: UISemantics.compactUiTarget(target, playerGui),
		canvas_position: result.canvasPosition,
		max_canvas_position: result.maxCanvasPosition,
	};
}

function interactUi(requestData: Record<string, unknown>): Record<string, unknown> {
	const contextOrError = UISemantics.getRuntimeUiContext();
	if ((contextOrError as Record<string, unknown>).success === false) {
		return contextOrError as Record<string, unknown>;
	}
	const context = contextOrError as { player: Player; playerGui: PlayerGui };
	const action = requestData.action;
	if (!typeIs(action, "string") || !SUPPORTED_ACTIONS.has(action)) {
		return requestError("invalid_ui_action", "action must be click, focus, type, scroll_into_view, or set_scroll.");
	}

	const candidates = UISemantics.resolveUiSelector(context, UISemantics.getUiSelector(requestData));
	if (candidates.size() === 0) {
		return requestError("ui_target_not_found", "No PlayerGui element matched the selector.");
	}
	if (candidates.size() > 1) {
		return {
			success: false,
			errorCode: "ambiguous_ui_selector",
			error: "ambiguous_ui_selector",
			message: "The UI selector matched multiple elements; refine it with an exact ref or path.",
			candidate_count: candidates.size(),
			candidates: compactCandidates(candidates, context.playerGui),
		};
	}

	const target = candidates[0];
	return action === "scroll_into_view" || action === "set_scroll"
		? runScrollAction(action, target, context.playerGui, requestData)
		: runRealInput(action, target, context.playerGui, requestData);
}

export = { interactUi };

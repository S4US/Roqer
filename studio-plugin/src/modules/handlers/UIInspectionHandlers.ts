import UISemantics from "../UISemantics";

function inspectUi(requestData: Record<string, unknown>): Record<string, unknown> {
	const contextOrError = UISemantics.getRuntimeUiContext();
	if ((contextOrError as Record<string, unknown>).success === false) {
		return contextOrError as Record<string, unknown>;
	}

	const context = contextOrError as {
		player: Player;
		playerGui: PlayerGui;
	};
	const rootOrError = UISemantics.resolveUiRoot(context, UISemantics.getRootRequest(requestData));
	if (!(rootOrError as Instance).IsA) return rootOrError as Record<string, unknown>;

	const root = rootOrError as Instance;
	const rootIdentity = UISemantics.safeIdentity(root);
	if (!rootIdentity) {
		return {
			success: false,
			errorCode: "ui_root_not_found",
			error: "ui_root_not_found",
			message: "The requested UI root is no longer available in the current playtest.",
		};
	}

	const options = UISemantics.normalizeUiInspectionOptions(requestData);
	const contextCollection = UISemantics.collectUiContext(root, context.playerGui, options);
	const collection = UISemantics.collectUiElements(root, options, contextCollection.semanticParent);
	return {
		success: true,
		source: "runtime_player_gui",
		root: rootIdentity,
		viewport: UISemantics.getViewport(),
		contextElements: contextCollection.contextElements,
		elements: collection.elements,
		limits: {
			maxDepth: options.maxDepth,
			maxNodes: options.maxNodes,
		},
		truncation: collection.truncation,
	};
}

export = { inspectUi };

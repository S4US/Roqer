/** Read-only, bounded scatter preparation. Placement commits belong to BuildHandlers. */
interface ScatterPlacement {
	source: Instance;
	position: [number, number, number];
	rotation: [number, number, number];
	scale: number;
	kit?: string;
}

interface Template {
	source: Instance;
	weight: number;
	radius: number;
	minY: number;
	kit?: string;
}

interface Obstacle {
	minX: number;
	maxX: number;
	minZ: number;
	maxZ: number;
	distance: number;
}

const MAX_DESCENDANTS = 20000;

function fail(message: string): never {
	error(`scatter: ${message}`, 0);
}

function number(value: unknown, field: string): number {
	if (!typeIs(value, "number") || value !== value || math.abs(value) === math.huge) fail(`${field} must be finite`);
	return value as number;
}

function record(value: unknown, field: string, allowed: string[]): Record<string, unknown> {
	if (!typeIs(value, "table")) fail(`${field} must be an object`);
	const result = value as Record<string, unknown>;
	for (const [key] of pairs(result)) {
		if (!typeIs(key, "string") || !allowed.includes(key)) fail(`${field} contains an unsupported field`);
	}
	return result;
}

function array(value: unknown, field: string, min: number, max: number): unknown[] {
	if (!typeIs(value, "table")) fail(`${field} must be an array`);
	const result = value as unknown[];
	const length = result.size();
	if (length < min || length > max) fail(`${field} must contain ${min} to ${max} entries`);
	let count = 0;
	for (const [key] of pairs(result)) {
		if (!typeIs(key, "number") || key < 1 || key > length || key % 1 !== 0) fail(`${field} must be a dense array`);
		count++;
	}
	if (count !== length) fail(`${field} must be a dense array`);
	return result;
}

function pair(value: unknown, field: string): [number, number] {
	const values = array(value, field, 2, 2);
	return [number(values[0], field), number(values[1], field)];
}

function path(value: unknown, field: string): string {
	if (!typeIs(value, "string") || value === "" || value.sub(1, 1) === "$") fail(`${field} must be a canonical instance path`);
	return value as string;
}

function inside(instance: Instance, ancestor?: Instance): boolean {
	return ancestor !== undefined && (instance === ancestor || instance.IsDescendantOf(ancestor));
}

function corners(frame: CFrame, size: Vector3, visit: (corner: Vector3) => void): void {
	for (const x of [-1, 1]) {
		for (const y of [-1, 1]) {
			for (const z of [-1, 1]) visit(frame.PointToWorldSpace(new Vector3(size.X * x / 2, size.Y * y / 2, size.Z * z / 2)));
		}
	}
}

function footprint(source: Instance): { radius: number; minY: number } {
	if (!source.IsA("BasePart") && !source.IsA("Model")) fail("templates must be BaseParts or Models");
	if (!source.IsDescendantOf(game) || !source.Archivable) fail("templates must be live, archivable instances");
	const pivot = source.IsA("BasePart") ? source.CFrame : (source as Model).GetPivot();
	let radius = 0;
	let minY = math.huge;
	let parts = 0;
	const queue: Instance[] = [source];
	// An explicit while is essential: roblox-ts can lower a numeric for loop
	// to a Luau numeric loop whose upper bound is captured before children join.
	let index = 0;
	while (index < queue.size()) {
		const item = queue[index];
		index += 1;
		if (!item.Archivable) fail("every template descendant must be archivable");
		if (item.IsA("BasePart")) {
			if (item !== source && source.IsA("BasePart")) fail("multipart templates must use a Model; child BaseParts do not move with a BasePart parent");
			parts++;
			corners(item.CFrame, item.Size, (corner) => {
				const relative = pivot.PointToObjectSpace(corner);
				radius = math.max(radius, math.sqrt(relative.X * relative.X + relative.Z * relative.Z));
				minY = math.min(minY, relative.Y);
			});
		}
		for (const child of item.GetChildren()) {
			if (queue.size() >= MAX_DESCENDANTS) fail(`template exceeds ${MAX_DESCENDANTS} instances`);
			queue.push(child);
		}
	}
	if (parts === 0) fail("template Models must contain at least one BasePart");
	return { radius: number(radius, "template radius"), minY: number(minY, "template lowest point") };
}

function obstacle(instance: Instance, distance: number): Obstacle {
	let frame: CFrame;
	let size: Vector3;
	if (instance.IsA("BasePart")) {
		frame = instance.CFrame;
		size = instance.Size;
	} else if (instance.IsA("Model")) {
		[frame, size] = instance.GetBoundingBox();
	} else fail("avoid tags must identify BaseParts or Models in Workspace");
	let minX = math.huge, maxX = -math.huge, minZ = math.huge, maxZ = -math.huge;
	corners(frame, size, (corner) => {
		minX = math.min(minX, corner.X);
		maxX = math.max(maxX, corner.X);
		minZ = math.min(minZ, corner.Z);
		maxZ = math.max(maxZ, corner.Z);
	});
	return {
		minX: number(minX, "obstacle bounds"), maxX: number(maxX, "obstacle bounds"),
		minZ: number(minZ, "obstacle bounds"), maxZ: number(maxZ, "obstacle bounds"), distance,
	};
}

export function planScatter(step: Record<string, unknown>, resolve: (path: string) => Instance, excluded?: Instance): {
	placements: ScatterPlacement[]; requested: number; attempts: number;
} {
	const Workspace = game.GetService("Workspace");
	const CollectionService = game.GetService("CollectionService");
	const zone = record(step.zone, "zone", ["min", "max"]);
	const min = pair(zone.min, "zone.min");
	const max = pair(zone.max, "zone.max");
	const width = number(max[0] - min[0], "zone width");
	const depth = number(max[1] - min[1], "zone depth");
	if (width <= 0 || depth <= 0) fail("zone.max must exceed zone.min on both axes");
	const density = number(step.density, "density");
	if (density <= 0) fail("density must be positive");
	const requested = math.floor(number(width * depth * density / 10000, "requested count"));
	if (requested < 1 || requested > 1000) fail("density and zone area must request between 1 and 1000 placements");
	const seed = number(step.seed, "seed");
	if (seed % 1 !== 0 || seed < 0 || seed > 2147483646) fail("seed must be an integer from 0 to 2147483646");
	const rotation = pair(step.rotation ?? [0, 360], "rotation");
	const scale = pair(step.scale ?? [1, 1], "scale");
	if (rotation[0] > rotation[1]) fail("rotation must be an ordered yaw range");
	number(rotation[1] - rotation[0], "rotation span");
	if (scale[0] < 0.05 || scale[1] > 20 || scale[0] > scale[1]) fail("scale must be an ordered range from 0.05 to 20");
	const spacing = number(step.spacing ?? 0, "spacing");
	if (spacing < 0) fail("spacing must be nonnegative");
	const maxSlope = number(step.maxSlope ?? 30, "maxSlope");
	if (maxSlope < 0 || maxSlope > 89) fail("maxSlope must be between 0 and 89 degrees");
	const raycast = record(step.raycast, "raycast", ["top", "bottom"]);
	const top = number(raycast.top, "raycast.top");
	const bottom = number(raycast.bottom, "raycast.bottom");
	if (top <= bottom || top - bottom > 100000) fail("raycast.top must exceed bottom by at most 100000 studs");
	const ground: Instance[] = [];
	for (const entry of array(step.ground, "ground", 1, 16)) {
		const root = resolve(path(entry, "ground entry"));
		if (!root.IsDescendantOf(Workspace) || !(root.IsA("BasePart") || root.IsA("Terrain") || root.IsA("Model") || root.IsA("Folder"))) fail("ground roots must be BaseParts, Terrain, Models, or Folders inside Workspace");
		if (inside(root, excluded) || (excluded !== undefined && inside(excluded, root))) fail("ground roots must not overlap the replaced scatter group");
		ground.push(root);
	}
	const templates: Template[] = [];
	let totalWeight = 0;
	for (const entry of array(step.templates, "templates", 1, 16)) {
		const spec = record(entry, "template", ["source", "weight", "kit"]);
		const source = resolve(path(spec.source, "template.source"));
		if (inside(source, excluded) || (excluded !== undefined && inside(excluded, source))) fail("templates must not overlap the replaced scatter group");
		const weight = number(spec.weight, "template.weight");
		if (weight <= 0) fail("template weights must be positive");
		if (spec.kit !== undefined && (!typeIs(spec.kit, "string") || spec.kit === "" || spec.kit.size() > 100)) fail("template.kit must be 1 to 100 characters");
		totalWeight = number(totalWeight + weight, "total template weight");
		templates.push({ source, weight, ...footprint(source), kit: spec.kit as string | undefined });
	}
	const obstacles: Obstacle[] = [];
	for (const entry of array(step.avoid ?? [], "avoid", 0, 16)) {
		const spec = record(entry, "avoid entry", ["tag", "distance"]);
		if (!typeIs(spec.tag, "string") || spec.tag === "" || spec.tag.size() > 100) fail("avoid.tag must be 1 to 100 characters");
		const distance = number(spec.distance, "avoid.distance");
		if (distance < 0) fail("avoid.distance must be nonnegative");
		for (const tagged of CollectionService.GetTagged(spec.tag as string)) {
			if (!tagged.IsDescendantOf(Workspace) || inside(tagged, excluded)) continue;
			if (excluded !== undefined && inside(excluded, tagged)) fail("avoid obstacles must not contain the replaced scatter group");
			if (obstacles.size() >= 1000) fail("avoid tags match more than 1000 obstacles");
			obstacles.push(obstacle(tagged, distance));
		}
	}
	const params = new RaycastParams();
	params.FilterType = Enum.RaycastFilterType.Include;
	params.FilterDescendantsInstances = ground;
	params.IgnoreWater = true;
	const placements: ScatterPlacement[] = [];
	const accepted: Array<{ x: number; z: number; radius: number }> = [];
	// Park-Miller's product is below 2^53; no platform-specific integer overflow.
	// The largest accepted seed maps to one, avoiding the generator's zero state.
	let randomState = (seed % 2147483646) + 1;
	const random = () => {
		randomState = (randomState * 48271) % 2147483647;
		return randomState / 2147483647;
	};
	let attempts = 0;
	const minNormalY = math.cos(math.rad(maxSlope));
	while (placements.size() < requested && attempts < requested * 20) {
		attempts++;
		// Every attempt consumes exactly five draws, including rejected candidates.
		const choose = random() * totalWeight;
		const yawDraw = random(), scaleDraw = random(), xDraw = random(), zDraw = random();
		let template = templates[templates.size() - 1];
		let cumulative = 0;
		for (const candidate of templates) {
			cumulative += candidate.weight;
			if (choose < cumulative) { template = candidate; break; }
		}
		const factor = scale[0] + (scale[1] - scale[0]) * scaleDraw;
		const radius = template.radius * factor;
		if (radius * 2 > width || radius * 2 > depth) continue;
		const x = min[0] + radius + (width - radius * 2) * xDraw;
		const z = min[1] + radius + (depth - radius * 2) * zDraw;
		let blocked = false;
		for (const obstacle of obstacles) {
			const dx = x - math.clamp(x, obstacle.minX, obstacle.maxX);
			const dz = z - math.clamp(z, obstacle.minZ, obstacle.maxZ);
			const clearance = radius + obstacle.distance;
			if (dx * dx + dz * dz <= clearance * clearance) { blocked = true; break; }
		}
		if (blocked) continue;
		for (const previous of accepted) {
			const dx = x - previous.x, dz = z - previous.z;
			const clearance = radius + previous.radius + spacing;
			if (dx * dx + dz * dz <= clearance * clearance) { blocked = true; break; }
		}
		if (blocked) continue;
		const hit = Workspace.Raycast(new Vector3(x, top, z), new Vector3(0, bottom - top, 0), params);
		if (hit === undefined || hit.Normal.Y < minNormalY) continue;
		placements.push({
			source: template.source, position: [x, hit.Position.Y - template.minY * factor, z],
			rotation: [0, rotation[0] + (rotation[1] - rotation[0]) * yawDraw, 0], scale: factor, kit: template.kit,
		});
		accepted.push({ x, z, radius });
	}
	if (placements.size() === 0) fail(`no valid placements after ${attempts} attempts; check ground, raycast heights, slope, avoidance, and template size`);
	return { placements, requested, attempts };
}

export default { planScatter };

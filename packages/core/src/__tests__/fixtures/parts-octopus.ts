// An octopus built from Parts, as the plugin reads a rigged model: a hidden
// root over a mantle, and eight arms of four segments each, hanging from
// under the mantle in a ring. Arm N's joints are ArmN (at the mantle), ArmNB,
// ArmNC and ArmND, base to tip; each segment is a stud long. It floats under
// an AnimationController, with every joint's frame lined up with the root.
import type { ModelRigJoint, ModelRigPart, ModelRigReading } from '../../animation/model-rig.js';
import { cf, motor, type V } from './parts-dog.js';

export const ARMS = 8;
export const SEGMENTS = ['', 'B', 'C', 'D'];

/** An arm's joints, base to tip. */
export const armJoints = (arm: number): string[] => SEGMENTS.map((segment) => `Arm${arm}${segment}`);

export function partsOctopus(options: { declarations?: unknown } = {}): ModelRigReading {
  const body = cf([0, 0, 0]);
  const parts: ModelRigPart[] = [
    { name: 'HumanoidRootPart', size: [3, 2.4, 3], hidden: true },
    { name: 'Mantle', size: [3, 2.4, 3] },
  ];
  const joints: ModelRigJoint[] = [motor('Root', ['HumanoidRootPart', body], ['Mantle', body], body)];
  for (let arm = 1; arm <= ARMS; arm += 1) {
    const angle = ((arm - 1) / ARMS) * 2 * Math.PI;
    const [x, z] = [Math.sin(angle) * 1.1, -Math.cos(angle) * 1.1];
    let parent: [string, ReturnType<typeof cf>] = ['Mantle', body];
    SEGMENTS.forEach((segment, index) => {
      const name = `Arm${arm}${segment}`;
      const top: V = [x, -1.2 - index, z];
      const part: [string, ReturnType<typeof cf>] = [name, cf([x, top[1] - 0.5, z])];
      parts.push({ name, size: [0.5, 1, 0.5] });
      joints.push(motor(name, parent, part, cf(top)));
      parent = part;
    });
  }
  return {
    path: 'game.Workspace.Octopus',
    revision: 'r1',
    rootPart: 'HumanoidRootPart',
    controller: 'AnimationController',
    parts,
    joints,
    ...(options.declarations === undefined ? {} : { declarations: JSON.stringify(options.declarations) }),
  };
}

/** Every arm joint may turn 90° from rest. */
export function armDeclarations(): Record<string, unknown> {
  const limits: Record<string, unknown> = {};
  for (let arm = 1; arm <= ARMS; arm += 1) for (const name of armJoints(arm)) limits[name] = { turn: 90 };
  return { version: 1, limits };
}

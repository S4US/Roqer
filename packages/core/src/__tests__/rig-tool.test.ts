// The animation tool's rig action for a model's own pieces, with Studio faked
// at the plugin boundary: the build form reads the pieces, has Studio make the
// planned rig, reads it back and draws its range sheet; the adopt form writes
// declarations only; a refusal reaches Studio's write never.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, test } from '@jest/globals';
import { BridgeService } from '../bridge-service.js';

process.env.ROBLOXSTUDIO_MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'roqer-rig-cache-'));
import { RobloxStudioTools } from '../tools/index.js';
import type { ModelRigReading } from '../animation/model-rig.js';
import type { PiecesReading, RigBuildPlan } from '../animation/rig-build.js';
import { dogJoints, dogPieces } from './fixtures/dog-pieces.js';
import { partsDog } from './fixtures/parts-dog.js';
import { skinnedWolfPieces } from './fixtures/skinned.js';

type ToolContent = { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri: string; mimeType: string } };
type Call = { endpoint: string; data: Record<string, unknown> };

const body = (result: { content: ToolContent[] }) => JSON.parse(result.content[0].text!);

/** The rig Studio reads back after making a plan exactly as planned. */
function readBackOf(plan: RigBuildPlan, pieces: PiecesReading): ModelRigReading {
  const sizes = new Map(pieces.parts.map((part) => [part.name, part]));
  const names = [plan.root.name, ...plan.joints.map((joint) => joint.part1)];
  return {
    path: plan.model,
    revision: 'rr1:built',
    rootPart: plan.root.name,
    controller: plan.controller.className,
    ...(plan.controller.hipHeight !== undefined ? { hipHeight: plan.controller.hipHeight } : {}),
    parts: [
      ...names.map((name) => (name === plan.root.name && plan.root.make
        ? { name, size: plan.root.make.size as [number, number, number], hidden: true }
        : { name, size: sizes.get(name)!.size, ...(sizes.get(name)!.shape ? { shape: sizes.get(name)!.shape } : {}), ...(sizes.get(name)!.mesh ? { mesh: sizes.get(name)!.mesh } : {}) })),
      // A skinned mesh's bones, which Studio reads beside the joints the plan made.
      ...(pieces.bones ?? []).map((bone) => ({ name: bone.name, size: [0.1, 0.1, 0.1] as [number, number, number], bone: true })),
    ],
    joints: [
      ...plan.joints,
      ...(pieces.bones ?? []).map((bone) => ({ name: bone.name, part0: bone.parent, part1: bone.name, c0: bone.cframe, c1: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] })),
    ],
    declarations: plan.declarations,
  };
}

function studio(answers: Record<string, (data: Record<string, unknown>) => unknown>) {
  const tools = new RobloxStudioTools(new BridgeService());
  const calls: Call[] = [];
  (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string, data: Record<string, unknown>) => {
    calls.push({ endpoint, data });
    const answer = answers[endpoint];
    if (!answer) throw new Error(`unexpected call to ${endpoint}`);
    return answer(data);
  };
  return { tools, calls };
}

const building = () => {
  const pieces = dogPieces();
  return studio({
    '/api/animation-read-pieces': () => pieces,
    '/api/animation-build-rig': (data) => ({
      rig: readBackOf(data.plan as RigBuildPlan, pieces),
      stamp: 'rr1:built',
      removed: [],
      rootAnchored: false,
      undoable: true,
    }),
  });
};

describe('rig joins a model\'s pieces', () => {
  test('it plans the rig from the pieces, has Studio make it, reads it back and draws its range sheet', async () => {
    const { tools, calls } = building();
    const result = await tools.animation({ action: 'rig', model: 'game.Workspace.Dog', joints: dogJoints(), controller: 'Humanoid', plan: 'quadruped' });
    expect(calls.map((call) => call.endpoint)).toEqual(['/api/animation-read-pieces', '/api/animation-build-rig']);
    const plan = calls[1].data.plan as RigBuildPlan;
    expect(plan).toMatchObject({ model: 'game.Workspace.Dog', revision: 'rp1:pieces', replaceImporter: false, rebuild: false });
    const answer = body(result);
    expect(answer).toMatchObject({
      rigged: true,
      model: 'game.Workspace.Dog',
      revision: 'rr1:built',
      plan: 'quadruped',
      controller: 'Humanoid',
      hipHeight: 1.6,
      root: { part: 'HumanoidRootPart', made: true, anchored: false },
      readBack: { matches: true },
      undoable: true,
      rig: {
        position: 'Root',
        feet: ['FrontLeftLower', 'FrontRightLower', 'HindLeftLower', 'HindRightLower'],
        limbs: ['FrontLeft', 'FrontRight', 'HindLeft', 'HindRight'],
      },
    });
    expect(answer.rangeSheet.reading).toContain('every joint but the root\'s turned 30° each way');
    expect(answer.rangeSheet.shows).toContain('every joint +30 about X');
    expect(answer).not.toHaveProperty('sheet');
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect((result.content[2] as ToolContent).resource).toMatchObject({ mimeType: 'model/gltf-binary' });
  });

  test('a read-back that differs from the plan says how', async () => {
    const pieces = dogPieces();
    const { tools } = studio({
      '/api/animation-read-pieces': () => pieces,
      '/api/animation-build-rig': (data) => {
        const rig = readBackOf(data.plan as RigBuildPlan, pieces);
        return { rig: { ...rig, hipHeight: 2 }, undoable: true };
      },
    });
    const answer = body(await tools.animation({ action: 'rig', model: 'game.Workspace.Dog', joints: dogJoints(), controller: 'Humanoid' }));
    expect(answer.readBack).toEqual({ matches: false, mismatches: ['its HipHeight is 2, not 1.6'] });
  });

  test('a build core refuses never reaches Studio\'s write', async () => {
    const { tools, calls } = building();
    const joints = dogJoints().map((joint) => (joint.part === 'Tail' ? { ...joint, pivot: [0, 0.3, 4] } : joint));
    const answer = body(await tools.animation({ action: 'rig', model: 'game.Workspace.Dog', joints, controller: 'Humanoid' }));
    expect(answer).toMatchObject({ error: 'game.Workspace.Dog was not rigged; nothing was changed.', errorCode: 'invalid_rig' });
    expect(answer.errors[0]).toContain('Tail: its pivot [0, 0.3, 4] lies outside Body');
    expect(calls.map((call) => call.endpoint)).toEqual(['/api/animation-read-pieces']);
  });

  test('Studio\'s refusal comes back as it is', async () => {
    const { tools } = studio({
      '/api/animation-read-pieces': () => dogPieces(),
      '/api/animation-build-rig': () => ({ error: 'game.Workspace.Dog has changed since its pieces were read. Nothing was changed; call rig again.', errorCode: 'model_changed' }),
    });
    expect(body(await tools.animation({ action: 'rig', model: 'game.Workspace.Dog', joints: dogJoints(), controller: 'Humanoid' }))).toMatchObject({ errorCode: 'model_changed' });
  });

  test('arguments that do not make one form are refused before Studio is asked', async () => {
    const { tools, calls } = building();
    const rig = (args: Record<string, unknown>) => tools.animation({ action: 'rig', model: 'game.Workspace.Dog', ...args });
    await expect(rig({ joints: dogJoints() })).rejects.toThrow(/controller must be Humanoid/);
    await expect(rig({ joints: dogJoints(), controller: 'Humanoid', plan: 'octopus' })).rejects.toThrow(/plan must be one of quadruped, custom/);
    await expect(rig({ joints: dogJoints(), controller: 'Humanoid', replace: 'all' })).rejects.toThrow(/replace must be "importer"/);
    await expect(rig({ stock: 'R15', joints: dogJoints() })).rejects.toThrow(/joints is for rigging a model's own pieces/);
    await expect(rig({ position: [0, 0, 0] })).rejects.toThrow(/position goes with stock/);
    await expect(rig({ replace: 'importer' })).rejects.toThrow(/replace goes with joints or a controller/);
    expect(body(await rig({ joints: [{ part: 'Head' }], controller: 'Humanoid' }))).toMatchObject({ errorCode: 'invalid_arguments' });
    expect(calls).toEqual([]);
  });

  test('with a controller and no joints, it builds around a skinned mesh, whose bones are its joints', async () => {
    const pieces = skinnedWolfPieces();
    const { tools, calls } = studio({
      '/api/animation-read-pieces': () => pieces,
      '/api/animation-build-rig': (data) => ({
        rig: readBackOf(data.plan as RigBuildPlan, pieces),
        stamp: 'rr1:built',
        removed: ['InitialPoses', 'AnimationController'],
        rootAnchored: false,
        undoable: true,
      }),
    });
    const answer = body(await tools.animation({ action: 'rig', model: 'game.Workspace.SkinnedWolf', controller: 'Humanoid', plan: 'quadruped', replace: 'importer' }));
    // Studio is asked to make one joint, the root's; the bones are there already.
    expect((calls[1].data.plan as RigBuildPlan).joints.map((joint) => joint.name)).toEqual(['Root']);
    expect(answer).toMatchObject({
      rigged: true,
      controller: 'Humanoid',
      root: { part: 'HumanoidRootPart', made: true },
      removed: ['InitialPoses', 'AnimationController'],
      readBack: { matches: true },
      rig: { position: 'Root', feet: ['FrontLeftFoot', 'FrontRightFoot', 'HindLeftFoot', 'HindRightFoot'] },
    });
    // Its mesh was not read here, so the sheet says the bones' motion does not show.
    expect(answer.rangeSheet.skin).toMatch(/^Wolf drawn rigid, its skin not read/);
  });

  test('a model with no bones is not rigged without joints', async () => {
    const { tools, calls } = building();
    const answer = body(await tools.animation({ action: 'rig', model: 'game.Workspace.Dog', controller: 'Humanoid' }));
    expect(answer.errorCode).toBe('invalid_arguments');
    expect(answer.errors[0]).toMatch(/has no Bones, so its rig is the joints the call gives/);
    expect(calls.map((call) => call.endpoint)).toEqual(['/api/animation-read-pieces']);
  });
});

describe('rig adopts a model\'s own joints', () => {
  test('with a plan, it writes the declarations at the revision read, and changes no joint', async () => {
    let written: string | undefined;
    const { tools, calls } = studio({
      '/api/animation-read-rig': () => (written === undefined ? partsDog({ knees: true }) : { ...partsDog({ knees: true }), revision: 'r2', declarations: written }),
      '/api/animation-declare-rig': (data) => {
        written = data.declarations as string;
        return { rig: { ...partsDog({ knees: true }), revision: 'r2', declarations: written }, undoable: true };
      },
    });
    const answer = body(await tools.animation({ action: 'rig', model: 'game.Workspace.Dog', plan: 'quadruped' }));
    expect(calls.map((call) => call.endpoint)).toEqual(['/api/animation-read-rig', '/api/animation-declare-rig']);
    expect(calls[1].data).toMatchObject({ model: 'game.Workspace.Dog', revision: 'r1' });
    expect(answer).toMatchObject({ declared: true, revision: 'r2', readBack: { matches: true }, rig: { feet: ['FrontLeftLower', 'FrontRightLower', 'HindLeftLower', 'HindRightLower'] } });
    expect(answer.rangeSheet).toBeDefined();
  });

  test('with neither plan nor declarations, it only reads the rig and draws it', async () => {
    const { tools, calls } = studio({ '/api/animation-read-rig': () => partsDog() });
    const answer = body(await tools.animation({ action: 'rig', model: 'game.Workspace.Dog' }));
    expect(calls.map((call) => call.endpoint)).toEqual(['/api/animation-read-rig']);
    expect(answer).toMatchObject({ declared: false, revision: 'r1' });
    expect(answer.note).toContain('Nothing was written');
  });

  test('declarations it already has need their revision', async () => {
    const { tools, calls } = studio({ '/api/animation-read-rig': () => partsDog({ declarations: { version: 1 } }) });
    expect(body(await tools.animation({ action: 'rig', model: 'game.Workspace.Dog', plan: 'quadruped' }))).toMatchObject({ errorCode: 'revision_required' });
    expect(calls).toHaveLength(1);
  });
});

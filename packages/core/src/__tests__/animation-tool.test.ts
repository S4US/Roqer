import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeService, RoutingFailure } from '../bridge-service.js';

// A cache of real rig meshes on this machine must not change what the tests draw.
process.env.ROBLOXSTUDIO_MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'roqer-rig-cache-'));
import { RobloxStudioTools } from '../tools/index.js';
import {
  PREVIEW_SAMPLES,
  choosePublisher,
  judgeMovement,
  normalizeAnimationId,
  prepareAnimation,
  previewSampleTimes,
  verifyLivePlayback,
  verifyPlayback,
  type PreviewSample,
} from '../animation/animation-tool.js';
import { buildTracks, sampleTrack } from '../animation/motion.js';
import { compilePoseAnimation, type KeyframeSequenceDescription } from '../animation/pose-compiler.js';
import { rigFor } from '../animation/rigs.js';
import { rigFromModel } from '../animation/model-rig.js';
import { partsDog } from './fixtures/parts-dog.js';

function wave(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Wave',
    rig: 'R15',
    loop: true,
    keyframes: [
      { time: 0, joints: { RightShoulder: { rotation: [0, 0, 60] }, RightElbow: { rotation: [30, 0, 0] } } },
      { time: 0.5, joints: { RightShoulder: { rotation: [0, 0, 100] }, RightElbow: { rotation: [60, 0, 0] } } },
      { time: 1, joints: { RightShoulder: { rotation: [0, 0, 60] }, RightElbow: { rotation: [30, 0, 0] } } },
    ],
    ...overrides,
  };
}

function compiled(input: unknown): KeyframeSequenceDescription {
  const result = compilePoseAnimation(input);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.sequence;
}

/** What a faithful Studio would report: core's own sampler, as CFrame components. */
function faithfulSamples(sequence: KeyframeSequenceDescription, nudge = 0): PreviewSample[] {
  const tracks = buildTracks(sequence);
  return previewSampleTimes(sequence).map((time) => ({
    time,
    transforms: Object.fromEntries(rigFor(sequence.rig).joints.map((joint) => {
      const frame = sampleTrack(tracks.get(joint.childPart), time);
      const c = [...frame.p, ...frame.r];
      if (joint.name === 'RightShoulder') c[0] += nudge;
      return [joint.childPart, c];
    })),
  }));
}

type ToolContent = { type: string; text?: string; data?: string; mimeType?: string; resource?: { mimeType: string; blob: string } };

function body(result: { content: ToolContent[] }) {
  return JSON.parse(result.content[0].text!);
}

describe('prepareAnimation', () => {
  test('refuses bad tool arguments together with compile errors', () => {
    const result = prepareAnimation({ ...wave(), rig: 'R7' }, { locomotion: 'yes', grounded: 1, waive: ['gait', 'velocity'] });
    expect(result).toEqual({
      ok: false,
      errors: [
        'locomotion: must be true or false',
        'grounded: must be true or false',
        'waive: unknown check "gait"; checks are jointLimits, velocity, rootDrift, loopContinuity, groundContact, footSliding, gaitSymmetry',
        'rig: must be R15 or R6, or the path of a rigged Model in Studio',
      ],
    });
  });

  test('separates failures the caller waived from those that block a build', () => {
    const still = { name: 'Stand', rig: 'R15', loop: true, keyframes: [{ time: 0, joints: { Neck: {} } }, { time: 1, joints: { Neck: {} } }] };
    const blocked = prepareAnimation(still, { locomotion: true });
    expect(blocked.ok && blocked.value.failing).toEqual(['gaitSymmetry']);
    const waived = prepareAnimation(still, { locomotion: true, waive: ['gaitSymmetry'] });
    expect(waived.ok && [waived.value.failing, waived.value.waived]).toEqual([[], ['gaitSymmetry']]);
  });
});

describe('verifyPlayback', () => {
  test('samples the middle of equal spans, and accepts a faithful playback', () => {
    const sequence = compiled(wave());
    const times = previewSampleTimes(sequence);
    expect(times).toHaveLength(PREVIEW_SAMPLES);
    expect(times[0]).toBeCloseTo(1 / 16);
    expect(times[PREVIEW_SAMPLES - 1]).toBeCloseTo(15 / 16);
    expect(verifyPlayback(sequence, faithfulSamples(sequence))).toEqual({ verified: true, samples: 8, maxDegrees: 0, maxStuds: 0 });
  });

  test('refuses a playback that strays from the checked model, or one that is malformed', () => {
    const sequence = compiled(wave());
    const strayed = verifyPlayback(sequence, faithfulSamples(sequence, 0.2));
    expect(strayed).toMatchObject({ verified: false, maxStuds: 0.2 });
    expect(strayed.reason).toBe('Studio played it up to 0° and 0.2 studs from the checked model; the limit is 1.5° and 0.05 studs');
    expect(verifyPlayback(sequence, [])).toMatchObject({ verified: false, reason: 'Studio returned no preview samples' });
    const missing = faithfulSamples(sequence);
    delete missing[3].transforms.Head;
    expect(verifyPlayback(sequence, missing)).toMatchObject({ verified: false, reason: 'the preview dummy reported no joint for Head' });
  });
});

describe('RobloxStudioTools.animation', () => {
  type Payload = Record<string, unknown> & { sampleTimes?: number[]; expectedRevision?: string };
  function toolsWith(responses: Record<string, (data: Payload) => unknown>) {
    const tools = new RobloxStudioTools(new BridgeService());
    const calls: { endpoint: string; data: Payload; instance_id?: string }[] = [];
    // The plugin round trip, replaced: each endpoint answers from `responses`.
    (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string, data: Payload, _target: unknown, instance_id?: string) => {
      // A build reads the stock rig's meshes first; here there are none, so it draws the stand-in.
      if (endpoint === '/api/animation-rig-meshes') return { error: 'no meshes in tests' };
      calls.push({ endpoint, data, instance_id });
      const respond = responses[endpoint];
      if (!respond) throw new Error(`unexpected call to ${endpoint}`);
      return respond(data);
    };
    return { tools, calls };
  }

  test('check compiles and measures without calling Studio', async () => {
    const { tools, calls } = toolsWith({});
    const result = body(await tools.animation({ action: 'check', animation: wave() }));
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ valid: true, animation: { name: 'Wave', keyframes: 3, loop: true, joints: ['RightShoulder', 'RightElbow'] }, checks: { passed: true } });
    expect(result.checks.results.map((check: { id: string }) => check.id)).toEqual([
      'jointLimits', 'velocity', 'rootDrift', 'loopContinuity', 'groundContact', 'footSliding', 'gaitSymmetry',
    ]);
    expect(body(await tools.animation({ action: 'check', animation: { ...wave(), keyframes: [] } })))
      .toEqual({ valid: false, errors: ['keyframes: must be a non-empty array'] });
  });

  test('check gives a gait the ground speed it was written for, and gives nothing else one', async () => {
    const reference = path.resolve(__dirname, '../../../../apps/desktop/agent/skills/roblox-animation-vfx/references/character-animation.md');
    const walk = [...fs.readFileSync(reference, 'utf8').matchAll(/```json\r?\n([\s\S]*?)```/g)]
      .map((match) => JSON.parse(match[1]) as { name: string })
      .find((recipe) => recipe.name === 'Walk');
    const { tools, calls } = toolsWith({});
    const gait = body(await tools.animation({ action: 'check', animation: walk, locomotion: true }));
    expect(gait.checks.passed).toBe(true);
    expect(gait.groundSpeed).toBeGreaterThan(2);
    expect(body(await tools.animation({ action: 'check', animation: walk })).groundSpeed).toBeUndefined();
    // A wave checked as a gait keeps its feet planted where they stand: written for standing still.
    const standing = body(await tools.animation({ action: 'check', animation: wave(), locomotion: true }));
    expect([standing.groundSpeed, standing.checks.passed]).toEqual([0, false]);
    expect(calls).toEqual([]);
  });

  test('check shows the motion: a contact sheet for the model and a GLB for the viewer', async () => {
    const { tools } = toolsWith({});
    const result = await tools.animation({ action: 'check', animation: wave() });
    const [text, image, resource] = result.content as ToolContent[];
    // The five even steps, and the wave's fastest instant between two of them.
    expect(JSON.parse(text.text!).sheet).toMatchObject({ times: [0, 0.2, 0.4, 0.558, 0.6, 0.8], shows: ['', '', '', 'fastest', '', ''] });
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const png = Buffer.from(image.data!, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1032, 508]);
    expect(resource).toMatchObject({ type: 'resource', resource: { mimeType: 'model/gltf-binary' } });
    // An invalid animation has nothing to show.
    expect((await tools.animation({ action: 'check', animation: { ...wave(), keyframes: [] } })).content).toHaveLength(1);
  });

  test('build refuses a failing check before Studio sees anything', async () => {
    const { tools, calls } = toolsWith({});
    const neckTwist = { name: 'Owl', rig: 'R15', keyframes: [{ time: 0, joints: { Neck: { rotation: [0, 150, 0] } } }] };
    const result = body(await tools.animation({ action: 'build', animation: neckTwist, parent: 'game.ServerStorage' }));
    expect(calls).toEqual([]);
    expect(result.error).toBe('A motion check failed (jointLimits); nothing was built. Fix the motion, or waive a failure you intend.');
    expect(result.checks.results[0]).toMatchObject({ id: 'jointLimits', status: 'fail', measured: { Neck: 150 } });
  });

  test('build previews, verifies and then writes, routing instance_id to both calls', async () => {
    const sequence = compiled(wave());
    const { tools, calls } = toolsWith({
      '/api/preview-animation': () => ({ length: 1, samples: faithfulSamples(sequence) }),
      '/api/build-animation': () => ({
        path: 'game.ServerStorage.Animations.Wave', instanceRef: 'ref-1', revision: 'kr1:abc', stampMatches: true,
        replaced: false, keyframes: 3, poses: sequence.poseCount, undoable: true,
      }),
    });
    const result = body(await tools.animation({ action: 'build', animation: wave(), parent: 'game.ServerStorage.Animations' }, 'place-1'));
    expect(calls.map((call) => [call.endpoint, call.instance_id])).toEqual([
      ['/api/preview-animation', 'place-1'],
      ['/api/build-animation', 'place-1'],
    ]);
    expect(calls[0].data.sampleTimes).toHaveLength(8);
    expect(calls[1].data).toMatchObject({ parentPath: 'game.ServerStorage.Animations', sequence: { name: 'Wave', loop: true, priority: 'Action' } });
    expect(result).toMatchObject({
      built: true,
      path: 'game.ServerStorage.Animations.Wave',
      revision: 'kr1:abc',
      replaced: false,
      undoable: true,
      readBack: { keyframes: 3, poses: sequence.poseCount, matchesCompiled: true },
      playback: { verified: true, samples: 8 },
      checks: { passed: true },
    });
  });

  test('build counts markers in the read-back, so a plugin that drops them does not match', async () => {
    const slash = {
      ...wave(),
      name: 'Slash',
      keyframes: [...wave().keyframes.slice(0, 2), { ...wave().keyframes[2], markers: [{ name: 'Hit', value: 'light' }] }],
    };
    const sequence = compiled(slash);
    expect(sequence.markerCount).toBe(1);
    const written = (markers?: number) => ({
      path: 'game.ServerStorage.Slash', instanceRef: 'ref-1', revision: 'kr1:abc', stampMatches: true,
      replaced: false, keyframes: 3, poses: sequence.poseCount, undoable: true, ...(markers === undefined ? {} : { markers }),
    });
    const current = toolsWith({
      '/api/preview-animation': () => ({ length: 1, samples: faithfulSamples(sequence) }),
      '/api/build-animation': () => written(1),
    });
    const built = body(await current.tools.animation({ action: 'build', animation: slash, parent: 'game.ServerStorage' }));
    expect((current.calls[1].data.sequence as KeyframeSequenceDescription).keyframes[2].markers).toEqual([{ name: 'Hit', value: 'light' }]);
    expect(built).toMatchObject({ animation: { markers: 1 }, readBack: { markers: 1, matchesCompiled: true } });

    // A plugin from before markers ignores them and reports no count.
    const old = toolsWith({
      '/api/preview-animation': () => ({ length: 1, samples: faithfulSamples(sequence) }),
      '/api/build-animation': () => written(),
    });
    expect(body(await old.tools.animation({ action: 'build', animation: slash, parent: 'game.ServerStorage' })).readBack.matchesCompiled).toBe(false);
  });

  test('builds an R6 animation on an R6 preview dummy, compared on R6 joints', async () => {
    const march = {
      name: 'March', rig: 'R6', loop: true,
      keyframes: [
        { time: 0, joints: { LeftHip: { aim: [0, -1, 0.4] }, RightHip: { aim: [0, -1, -0.4] } } },
        { time: 0.5, joints: { LeftHip: { aim: [0, -1, -0.4] }, RightHip: { aim: [0, -1, 0.4] } } },
        { time: 1, joints: { LeftHip: { aim: [0, -1, 0.4] }, RightHip: { aim: [0, -1, -0.4] } } },
      ],
    };
    const sequence = compiled(march);
    const { tools, calls } = toolsWith({
      '/api/preview-animation': () => ({ length: 1, samples: faithfulSamples(sequence) }),
      '/api/build-animation': () => ({
        path: 'game.ServerStorage.March', instanceRef: 'ref-1', revision: 'kr1:abc', stampMatches: true,
        replaced: false, keyframes: 3, poses: sequence.poseCount, markers: 0, undoable: true,
      }),
    });
    const result = body(await tools.animation({ action: 'build', animation: march, parent: 'game.ServerStorage' }));
    expect(calls[0].data.sequence).toMatchObject({ rig: 'R6' });
    expect(result).toMatchObject({ built: true, playback: { verified: true }, readBack: { matchesCompiled: true }, sheet: { rig: 'the R6 rig, whose parts are blocks' } });
    // An R15 dummy has no Torso: an old plugin that ignores the rig is caught.
    const r15Samples = previewSampleTimes(sequence).map((time) => ({ time, transforms: { LowerTorso: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] } }));
    expect(verifyPlayback(sequence, r15Samples)).toMatchObject({ verified: false, reason: 'the preview dummy reported no joint for Torso' });
  });

  test('build writes nothing when the preview fails or strays', async () => {
    const sequence = compiled(wave());
    const failed = toolsWith({ '/api/preview-animation': () => ({ error: 'the preview track never loaded.' }) });
    expect(body(await failed.tools.animation({ action: 'build', animation: wave(), parent: 'game.ServerStorage' })).error)
      .toBe('Studio could not preview the animation: the preview track never loaded. Nothing was built.');
    expect(failed.calls.map((call) => call.endpoint)).toEqual(['/api/preview-animation']);

    const strayed = toolsWith({ '/api/preview-animation': () => ({ length: 1, samples: faithfulSamples(sequence, 0.3) }) });
    const result = body(await strayed.tools.animation({ action: 'build', animation: wave(), parent: 'game.ServerStorage' }));
    expect(result.error).toMatch(/^The preview did not play as checked: Studio played it up to .*\. Nothing was built\.$/);
    expect(strayed.calls.map((call) => call.endpoint)).toEqual(['/api/preview-animation']);
  });

  test('a refused write comes back with its reason and current revision', async () => {
    const sequence = compiled(wave());
    const { tools } = toolsWith({
      '/api/preview-animation': () => ({ length: 1, samples: faithfulSamples(sequence) }),
      '/api/build-animation': (data) => ({
        error: 'game.ServerStorage.Wave changed since that revision; build again with the current one. Nothing was built.',
        errorCode: 'revision_conflict',
        currentRevision: 'kr1:new',
        sent: data.expectedRevision,
      }),
    });
    const result = body(await tools.animation({ action: 'build', animation: wave(), parent: 'game.ServerStorage', expected_revision: 'kr1:old' }));
    expect(result).toMatchObject({ errorCode: 'revision_conflict', currentRevision: 'kr1:new', sent: 'kr1:old' });
  });

  test('rejects malformed arguments outright', async () => {
    const { tools } = toolsWith({});
    await expect(tools.animation({ action: 'play', animation: wave() })).rejects.toThrow('animation action must be check, build, publish, wire, verify or rig');
    await expect(tools.animation({ action: 'build', animation: wave(), parent: '' })).rejects.toThrow(/parent .* is required/);
    await expect(tools.animation({ action: 'build', animation: wave(), parent: 'game.ServerStorage', expected_revision: 7 })).rejects.toThrow('expected_revision must be');
    await expect(tools.animation({ action: 'wire', slot: 'dance', animation_id: 'rbxassetid://1' })).rejects.toThrow(/slot must be one of idle, walk, run/);
    await expect(tools.animation({ action: 'wire', slot: 'run', animation_id: 'not an id' })).rejects.toThrow(/animation_id must be/);
    await expect(tools.animation({ action: 'verify', animation: wave(), slot: 'run' })).rejects.toThrow(/animation_id is required with slot/);
  });
});

describe('publishing', () => {
  const owner = (creatorType: string, creatorId: number) => ({ creatorType, creatorId });

  test('uploads only as the place owner, and names an unpublished place', () => {
    expect(choosePublisher(owner('User', 42), { userId: '42' })).toMatchObject({ ok: true, creator: { userId: '42' } });
    expect(choosePublisher(owner('Group', 7), { groupId: '7' })).toMatchObject({ ok: true, creator: { groupId: '7' } });
    expect(choosePublisher(owner('Group', 7), { userId: '42' })).toMatchObject({ ok: false, errorCode: 'owner_mismatch' });
    expect(choosePublisher(owner('User', 42), { userId: '43' })).toMatchObject({ ok: false, errorCode: 'owner_mismatch' });
    expect(choosePublisher(owner('User', 42), { groupId: '7', userId: '42' })).toMatchObject({ ok: false, errorCode: 'owner_mismatch' });
    expect(choosePublisher(owner('User', 42), {})).toMatchObject({ ok: false, errorCode: 'creator_not_configured' });
    const unpublished = choosePublisher(owner('User', 0), { userId: '42' });
    expect(unpublished).toMatchObject({ ok: true, creator: { userId: '42' } });
    expect(unpublished.ok && unpublished.ownerCheck).toMatch(/not published/);
  });

  test('reads an asset ID in any form Roblox accepts', () => {
    expect(normalizeAnimationId('rbxassetid://123')).toBe('rbxassetid://123');
    expect(normalizeAnimationId('http://www.roblox.com/asset/?id=507770239')).toBe('rbxassetid://507770239');
    expect(normalizeAnimationId(' 99 ')).toBe('rbxassetid://99');
    expect(normalizeAnimationId(99)).toBe('rbxassetid://99');
    for (const bad of ['rbxassetid://', '0', 'rbxassetid://12a', 'abc', -1, 1.5, null]) expect(normalizeAnimationId(bad)).toBeUndefined();
  });

  function publishingTools(responses: Record<string, (data: Payload) => unknown>, upload: Record<string, unknown>) {
    const tools = new RobloxStudioTools(new BridgeService());
    const calls: string[] = [];
    (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string, data: Payload) => {
      calls.push(endpoint);
      return responses[endpoint](data);
    };
    const uploads: unknown[] = [];
    (tools as unknown as { openCloudClient: unknown }).openCloudClient = {
      hasApiKey: () => true,
      createAsset: async (request: unknown) => {
        uploads.push(request);
        return upload;
      },
    };
    return { tools, calls, uploads };
  }
  type Payload = Record<string, unknown>;
  const info = { path: 'game.ServerStorage.Wave', name: 'Wave', revision: 'kr1:abc', placeCreatorType: 'User', placeCreatorId: 42 };
  const done = { path: 'operations/op-1', done: true, response: { assetId: '555', moderationResult: { moderationState: 'Approved' } } };

  test('publishes as the owner and confirms the asset holds what was built', async () => {
    const saved = process.env.ROBLOX_CREATOR_USER_ID;
    process.env.ROBLOX_CREATOR_USER_ID = '42';
    try {
      const { tools, calls, uploads } = publishingTools({
        '/api/animation-publish-info': () => info,
        '/api/export-rbxm': () => ({ base64: Buffer.from('rbxm').toString('base64') }),
        '/api/animation-read-back': (data) => ({ matches: data.expectedRevision === 'kr1:abc', keyframes: 3, poses: 21 }),
      }, done);
      const result = body(await tools.animation({ action: 'publish', path: 'game.ServerStorage.Wave' }));
      expect(calls).toEqual(['/api/animation-publish-info', '/api/export-rbxm', '/api/animation-read-back']);
      expect(uploads).toEqual([expect.objectContaining({ assetType: 'Animation', displayName: 'Wave', creationContext: { creator: { userId: '42' } } })]);
      expect(result).toMatchObject({
        published: true, assetId: '555', animationId: 'rbxassetid://555', creator: { user: '42' },
        moderation: 'Approved', approved: true, readBack: { matches: true },
      });
    } finally {
      if (saved === undefined) delete process.env.ROBLOX_CREATOR_USER_ID; else process.env.ROBLOX_CREATOR_USER_ID = saved;
    }
  });

  test('uploads nothing for a place someone else owns, and never calls a rejection published', async () => {
    const saved = process.env.ROBLOX_CREATOR_USER_ID;
    process.env.ROBLOX_CREATOR_USER_ID = '42';
    try {
      const groupPlace = publishingTools({ '/api/animation-publish-info': () => ({ ...info, placeCreatorType: 'Group', placeCreatorId: 7 }) }, done);
      const refused = body(await groupPlace.tools.animation({ action: 'publish', path: 'game.ServerStorage.Wave' }));
      expect(refused.errorCode).toBe('owner_mismatch');
      expect(groupPlace.uploads).toEqual([]);

      const rejected = publishingTools({
        '/api/animation-publish-info': () => info,
        '/api/export-rbxm': () => ({ base64: 'cmJ4bQ==' }),
        '/api/animation-read-back': () => ({ matches: true }),
      }, { ...done, response: { assetId: '556', moderationResult: { moderationState: 'Rejected' } } });
      expect(body(await rejected.tools.animation({ action: 'publish', path: 'game.ServerStorage.Wave' })))
        .toMatchObject({ published: false, moderation: 'Rejected', approved: false });
    } finally {
      if (saved === undefined) delete process.env.ROBLOX_CREATOR_USER_ID; else process.env.ROBLOX_CREATOR_USER_ID = saved;
    }
  });

  test('without an Open Cloud key, says how to publish and uploads nothing', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    (tools as unknown as { openCloudClient: unknown }).openCloudClient = { hasApiKey: () => false };
    const result = body(await tools.animation({ action: 'publish', path: 'game.ServerStorage.Wave' }));
    expect(result.errorCode).toBe('open_cloud_not_configured');
    expect(result.error).toMatch(/verify plays the animation in a playtest/);
  });
});

describe('verifying in a playtest', () => {
  test('compares only the joints the animation keys, since other tracks blend into the rest', () => {
    const sequence = compiled(wave());
    const samples = faithfulSamples(sequence).map((sample) => ({
      ...sample,
      transforms: { ...sample.transforms, Head: [0, 0, 0, 0, -1, 0, 1, 0, 0, 0, 0, 1] },
    }));
    expect(verifyLivePlayback(sequence, samples)).toMatchObject({ verified: true, maxDegrees: 0 });
    expect(verifyLivePlayback(sequence, faithfulSamples(sequence, 0.3))).toMatchObject({ verified: false, maxStuds: 0.3 });
  });

  test('plays on the playtest client and checks the wired slot', async () => {
    const sequence = compiled(wave());
    const tools = new RobloxStudioTools(new BridgeService());
    const calls: { endpoint: string; data: Record<string, unknown>; target: unknown }[] = [];
    (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string, data: Record<string, unknown>, target: unknown) => {
      calls.push({ endpoint, data, target });
      return {
        length: 1,
        samples: faithfulSamples(sequence),
        wiredIds: ['rbxassetid://555', 'http://www.roblox.com/asset/?id=555'],
        playingIds: ['rbxassetid://555'],
      };
    };
    const result = body(await tools.animation({ action: 'verify', animation: wave(), animation_id: '555', slot: 'idle' }));
    expect(calls).toEqual([{ endpoint: '/api/animation-verify', data: expect.objectContaining({ animationId: 'rbxassetid://555', slot: 'idle' }), target: 'client-1' }]);
    expect(calls[0].data).not.toHaveProperty('sequence');
    expect(result).toMatchObject({
      verified: true,
      played: { source: 'published', verified: true },
      wiring: { slot: 'idle', matches: true, playingNow: true },
    });
  });

  test('refuses to verify on a character of the other rig', async () => {
    const sequence = compiled(wave());
    const tools = new RobloxStudioTools(new BridgeService());
    (tools as unknown as { _callSingle: unknown })._callSingle = async () => ({ length: 1, samples: faithfulSamples(sequence), rigType: 'R6' });
    const result = body(await tools.animation({ action: 'verify', animation: wave() }));
    expect(result).toMatchObject({ errorCode: 'rig_mismatch', characterRig: 'R6' });
    expect(result.error).toBe('The playtest character is R6, but the animation is for R15, so it cannot play on it. Nothing was verified. Make the animation for R6, or set the place\'s avatar type to R15.');
  });

  test('given only a path, asks for the checked animation and calls nothing', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const calls: string[] = [];
    (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string) => { calls.push(endpoint); return {}; };
    const result = body(await tools.animation({ action: 'verify', path: 'game.ServerStorage.Run' }));
    expect(result.error).toMatch(/pass the same animation you checked and built, not only its path/);
    expect(calls).toEqual([]);
  });
});

describe('animating a model', () => {
  type Call = { endpoint: string; data: Record<string, unknown>; target: unknown; instance_id?: string };
  function toolsAnswering(answer: (endpoint: string, data: Record<string, unknown>) => unknown) {
    const tools = new RobloxStudioTools(new BridgeService());
    const calls: Call[] = [];
    (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string, data: Record<string, unknown>, target: unknown, instance_id?: string) => {
      calls.push({ endpoint, data, target, instance_id });
      return answer(endpoint, data);
    };
    return { tools, calls };
  }

  test('wire sets the state of the model\'s loader it names, paced by its ground speed', async () => {
    const { tools, calls } = toolsAnswering(() => ({
      model: 'game.Workspace.Guard',
      loader: 'game.Workspace.Guard.RoqerModelAnimate',
      installed: true,
      slot: 'walk',
      animationId: 'rbxassetid://555',
      previousId: false,
      groundSpeed: 2.2,
      readBackMatches: true,
      undoable: true,
    }));
    const result = body(await tools.animation(
      { action: 'wire', model: 'game.Workspace.Guard', slot: 'walk', animation_id: '555', ground_speed: 2.2 },
      'place:1',
    ));
    expect(calls).toEqual([{
      endpoint: '/api/animation-wire-model',
      data: { model: 'game.Workspace.Guard', state: 'walk', animationId: 'rbxassetid://555', expectedId: undefined, groundSpeed: 2.2 },
      target: undefined,
      instance_id: 'place:1',
    }]);
    expect(result).toMatchObject({ wired: true, installed: true, groundSpeed: 2.2, readBackMatches: true });
    expect(result).not.toHaveProperty('note');
  });

  test('a gait wired without its ground speed says its feet may slide; an idle has no pace to keep', async () => {
    const { tools } = toolsAnswering((_endpoint, data) => ({ slot: data.state, animationId: data.animationId, readBackMatches: true }));
    const walk = body(await tools.animation({ action: 'wire', model: 'game.Workspace.Guard', slot: 'run', animation_id: '7', expected_id: 'rbxassetid://6' }));
    expect(walk.note).toMatch(/plays this run at its own pace whatever the model's speed, so its feet may slide/);
    const idle = body(await tools.animation({ action: 'wire', model: 'game.Workspace.Guard', slot: 'idle', animation_id: '8' }));
    expect(idle).toMatchObject({ wired: true });
    expect(idle).not.toHaveProperty('note');
  });

  test('refuses what a loader cannot play before Studio sees it', async () => {
    const { tools, calls } = toolsAnswering(() => ({}));
    const wire = (args: Record<string, unknown>) => tools.animation({ action: 'wire', model: 'game.Workspace.Guard', slot: 'walk', animation_id: '5', ...args });
    await expect(wire({ slot: 'jump' })).rejects.toThrow('with model, slot must be one of idle, walk, run: the states its loader plays by how fast it moves');
    await expect(wire({ model: ' ' })).rejects.toThrow(/model must be the path of the NPC or creature Model/);
    await expect(wire({ expected_id: 'the old one' })).rejects.toThrow(/expected_id must be the asset ID the model's walk holds now/);
    await expect(wire({ slot: 'idle', ground_speed: 2 })).rejects.toThrow('ground_speed is for walk and run: an idle does not move');
    for (const groundSpeed of [0, -1, 201, Number.NaN, '2.2']) {
      await expect(wire({ ground_speed: groundSpeed })).rejects.toThrow(/ground_speed must be the groundSpeed its check reported: above 0 and at most 200/);
    }
    expect(calls).toEqual([]);
  });

  test('a refusal from Studio comes back as it was given, with nothing wired', async () => {
    const refusal = { error: 'game.Workspace.Guard.RoqerModelAnimate is not the loader this tool installs, or its code was changed; it is left alone. Nothing was wired.', errorCode: 'loader_modified' };
    const { tools } = toolsAnswering(() => refusal);
    const result = body(await tools.animation({ action: 'wire', model: 'game.Workspace.Guard', slot: 'walk', animation_id: '5', ground_speed: 3 }));
    expect(result).toEqual(refusal);
  });

  test('rig makes a stock body at the path, its feet where asked, and says its states are the defaults', async () => {
    const { tools, calls } = toolsAnswering(() => ({
      model: 'game.Workspace.Guard',
      rigType: 'R15',
      parts: 16,
      joints: 15,
      height: 5.2,
      feet: [4, 0, -2],
      walkSpeed: 16,
      loader: 'game.Workspace.Guard.RoqerModelAnimate',
      states: { idle: 'rbxassetid://1', walk: 'rbxassetid://2', run: 'rbxassetid://3' },
      animateRemoved: true,
      readBackMatches: true,
      undoable: true,
    }));
    const result = body(await tools.animation({ action: 'rig', model: 'game.Workspace.Guard', stock: 'R15', position: [4, 0, -2] }, 'place:1'));
    expect(calls).toEqual([{
      endpoint: '/api/animation-rig',
      data: { model: 'game.Workspace.Guard', stock: 'R15', position: [4, 0, -2] },
      target: undefined,
      instance_id: 'place:1',
    }]);
    expect(result).toMatchObject({ rigged: true, rigType: 'R15', feet: [4, 0, -2], readBackMatches: true });
    expect(result.note).toMatch(/^states holds Roblox's default idle, walk, run\. Their ground speed is unknown/);
    // Without a position, the plugin stands it at the origin.
    await tools.animation({ action: 'rig', model: 'game.Workspace.Guard2', stock: 'R6' });
    expect(calls[1].data).toEqual({ model: 'game.Workspace.Guard2', stock: 'R6' });
  });

  test('a read-back that differs says how, and the NPC it made is still reported', async () => {
    const mismatches = ['its feet stand at [0, -0.19, 0], 0.19 studs from where they were asked'];
    const { tools } = toolsAnswering(() => ({ model: 'game.Workspace.Guard', rigType: 'R15', states: { idle: 'rbxassetid://1' }, readBackMatches: false, mismatches }));
    const result = body(await tools.animation({ action: 'rig', model: 'game.Workspace.Guard', stock: 'R15' }));
    expect(result).toMatchObject({ rigged: true, readBackMatches: false, mismatches });
  });

  test('rig says so when the body carried no default animations', async () => {
    const { tools } = toolsAnswering(() => ({ model: 'game.Workspace.Guard', rigType: 'R6', states: {}, missingStates: ['idle', 'walk', 'run'], readBackMatches: true }));
    const result = body(await tools.animation({ action: 'rig', model: 'game.Workspace.Guard', stock: 'R6' }));
    expect(result).toMatchObject({ rigged: true, missingStates: ['idle', 'walk', 'run'] });
    expect(result.note).toBe('Its body carried no default animations, so its loader holds none yet: wire its idle, walk and run with model.');
  });

  test('rig refuses what it cannot make before Studio sees it', async () => {
    const { tools, calls } = toolsAnswering(() => ({}));
    const rig = (args: Record<string, unknown>) => tools.animation({ action: 'rig', model: 'game.Workspace.Guard', stock: 'R15', ...args });
    await expect(rig({ model: ' ' })).rejects.toThrow(/model must be the path of the NPC to make/);
    await expect(rig({ stock: undefined })).rejects.toThrow(/^stock is required: rig makes a stock R15 or R6 NPC body/);
    await expect(rig({ stock: 'R16' })).rejects.toThrow('stock must be R15 or R6');
    for (const position of [[1, 2], [1, 2, '3'], [1, Number.NaN, 3], 'origin']) {
      await expect(rig({ position })).rejects.toThrow(/^position must be \[x, y, z\]: where the NPC's feet stand/);
    }
    expect(calls).toEqual([]);
  });

  test('a path that already names something is refused by Studio, with nothing made', async () => {
    const refusal = { error: 'game.Workspace.Guard already exists; rig makes a new NPC at a path that names nothing. Nothing was made.', errorCode: 'target_exists' };
    const { tools } = toolsAnswering(() => refusal);
    expect(body(await tools.animation({ action: 'rig', model: 'game.Workspace.Guard', stock: 'R15' }))).toEqual(refusal);
  });
});

describe('judging a model as it moves', () => {
  const IDLE = 'rbxassetid://1';
  const WALK = 'rbxassetid://2';
  const RUN = 'rbxassetid://3';
  const LOADER = { unchanged: true, ids: { idle: IDLE, walk: WALK }, speeds: { walk: 2.2 } };

  /**
   * A walk to a position as the plugin samples it: three seconds moving, the
   * loader still fading from the idle over the first two samples, then a
   * second and a half standing, fading back to the idle.
   */
  function walked(options: { speed?: number; pace?: number; moving?: string | false; standing?: string | false; phase?: string } = {}) {
    const { speed = 4.4, pace = 2, moving = WALK, standing = IDLE, phase } = options;
    const samples: Record<string, unknown>[] = [];
    let t = 0;
    for (let index = 0; index < 30; index += 1) {
      t = Math.round((t + 0.1) * 100) / 100;
      samples.push({ t, phase: phase ?? 'moving', speed: index < 2 ? (speed * index) / 2 : speed, playing: index < 2 ? IDLE : moving, pace: index < 2 ? 1 : pace });
    }
    for (let index = 0; index < 15; index += 1) {
      t = Math.round((t + 0.1) * 100) / 100;
      samples.push({ t, phase: phase ?? 'standing', speed: index < 1 ? 1.5 : 0, playing: index < 2 ? moving : standing, pace: 1 });
    }
    return { mode: phase === 'watching' ? 'watched' : 'walked', ...(phase === 'watching' ? {} : { reached: true }), samples };
  }

  test('the walk while it moves, the idle while it stands, at the model\'s pace', () => {
    const check = judgeMovement(walked(), LOADER);
    expect(check).toMatchObject({
      verified: true,
      mode: 'walked',
      reached: true,
      // Moving from 0.2 s and standing from 3.2 s, the 0.4 s settling after each is
      // left out: 0.6 to 3 s judge moving, 3.6 to 4.5 s standing.
      moving: { samples: 25, averageSpeed: 4.4, played: { walk: 25 } },
      standing: { samples: 10, played: { idle: 10 } },
      pace: { state: 'walk', groundSpeed: 2.2, averageSpeed: 4.4, needed: 2, played: 2, kept: true },
    });
    expect(check.reason).toBeUndefined();
  });

  test('a gait the loader cannot pace says how to fix it', () => {
    const tooFast = judgeMovement(walked({ speed: 16, pace: 2 }), LOADER);
    expect(tooFast).toMatchObject({ verified: false, pace: { needed: 7.27, kept: false } });
    expect(tooFast.reason).toBe('it moved at 16 studs a second, but its walk is written for 2.2, and the loader plays a gait at most twice as fast, so its feet slide: make a faster walk, or move it at most 4.4 studs a second (a Humanoid moves at its WalkSpeed)');
    const tooSlow = judgeMovement(walked({ speed: 1, pace: 0.5 }), { ...LOADER, speeds: { walk: 8 } });
    expect(tooSlow.reason).toMatch(/at least half as fast, so its feet slide: make a slower walk, or move it at least 4 studs a second \(a Humanoid moves at its WalkSpeed\)$/);
    const lagging = judgeMovement(walked({ pace: 1 }), LOADER);
    expect(lagging.reason).toBe('the loader played its walk at 1 times its speed where the model\'s pace needed 2');
  });

  test('a state that did not play is named, with how long it played', () => {
    const noWalk = judgeMovement(walked({ moving: IDLE }), LOADER);
    expect(noWalk).toMatchObject({ verified: false, moving: { played: { idle: 25 } } });
    expect(noWalk.reason).toBe('its walk played for 0% of the time it moved; it needs 80%');
    const noIdle = judgeMovement(walked({ standing: WALK }), LOADER);
    expect(noIdle.reason).toMatch(/^its idle played for 0% of the time it stood; it needs 80%/);
    const other = judgeMovement(walked({ moving: 'rbxassetid://99' }), LOADER);
    expect(other.moving.played).toEqual({ 'something else': 25 });
  });

  test('with no idle wired it stands still, and a run counts as moving', () => {
    const loader = { unchanged: true, ids: { run: RUN }, speeds: { run: 4.4 } };
    const check = judgeMovement(walked({ moving: RUN, standing: false, pace: 1 }), loader);
    expect(check).toMatchObject({ verified: true, standing: { played: { nothing: 10 } }, pace: { state: 'run', needed: 1, kept: true } });
    expect(check.notes).toEqual(['no idle is wired, so it stands in its rest pose']);
  });

  test('a model that walked and ran is paced by the gait it played most, not their mix', () => {
    const loader = { unchanged: true, ids: { idle: IDLE, walk: WALK, run: RUN }, speeds: { walk: 2.2, run: 4.4 } };
    const observation = walked({ moving: RUN, speed: 4.4, pace: 1 });
    // Its first judged second is a walk at half the speed, at the walk's own pace.
    for (const sample of observation.samples.slice(5, 15)) Object.assign(sample, { playing: WALK, speed: 2.2, pace: 1 });
    const check = judgeMovement(observation, loader);
    expect(check).toMatchObject({ verified: true, moving: { played: { walk: 10, run: 15 } }, pace: { state: 'run', groundSpeed: 4.4, averageSpeed: 4.4, needed: 1, kept: true } });
  });

  test('a gait with no ground speed is not paced, and says its feet may slide', () => {
    const check = judgeMovement(walked({ pace: 1 }), { ...LOADER, speeds: {} });
    expect(check.verified).toBe(true);
    expect(check.pace).toBeUndefined();
    expect(check.notes).toEqual(['its walk has no ground speed, so the loader plays it at its own pace and its feet may slide']);
  });

  test('without a loader, or without moving, nothing is verified', () => {
    expect(judgeMovement(walked(), false)).toMatchObject({ verified: false, reason: 'the model has no RoqerModelAnimate loader: wire its idle, walk or run first' });
    const stuck = judgeMovement({ ...walked({ speed: 0.3 }), reached: false }, LOADER);
    expect(stuck).toMatchObject({ verified: false, reached: false });
    expect(stuck.reason).toMatch(/^it hardly moved: MoveTo found no way to the position, or something held it/);
    const unwired = judgeMovement(walked(), { unchanged: true, ids: { idle: IDLE }, speeds: {} });
    expect(unwired.reason).toBe('no walk or run is wired, so nothing played while it moved');
    expect(judgeMovement({ mode: 'walked', samples: [{ t: 0, speed: 'fast' }] }, LOADER).reason).toBe('the playtest returned a malformed sample');
  });

  test('watching a model something else moves sorts its samples by speed', () => {
    const check = judgeMovement(walked({ phase: 'watching' }), LOADER);
    // Unlike a walk, a watch has no phases: the first sample after the stop, still
    // at 1.5 studs a second, counts as moving.
    expect(check).toMatchObject({ verified: true, mode: 'watched', moving: { samples: 26 }, standing: { samples: 10 } });
    expect(check).not.toHaveProperty('reached');
    const still = judgeMovement(walked({ phase: 'watching', speed: 0 }), LOADER);
    expect(still.reason).toMatch(/^it did not move while it was watched; walk it with position/);
  });
});

describe('verifying a model in a playtest', () => {
  type Call = { endpoint: string; data: Record<string, unknown>; target: unknown; instance_id?: string; timeoutMs?: number };
  const IDLE = 'rbxassetid://1';
  const WALK = 'rbxassetid://2';
  function toolsAnswering(answer: (data: Record<string, unknown>) => unknown) {
    const tools = new RobloxStudioTools(new BridgeService());
    const calls: Call[] = [];
    (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string, data: Record<string, unknown>, target: unknown, instance_id?: string, timeoutMs?: number) => {
      calls.push({ endpoint, data, target, instance_id, timeoutMs });
      return answer(data);
    };
    return { tools, calls };
  }
  function walkedSamples() {
    const samples: Record<string, unknown>[] = [];
    for (let index = 1; index <= 30; index += 1) samples.push({ t: index / 10, phase: 'moving', speed: 4, playing: WALK, pace: 1 });
    for (let index = 31; index <= 45; index += 1) samples.push({ t: index / 10, phase: 'standing', speed: 0, playing: IDLE, pace: 1 });
    return samples;
  }
  const LOADER = { unchanged: true, ids: { idle: IDLE, walk: WALK }, speeds: { walk: 4 } };

  test('walks the model on the playtest server and judges its loader, with the checked animation played on it', async () => {
    const sequence = compiled(wave());
    const { tools, calls } = toolsAnswering(() => ({
      rigType: 'R15',
      loader: LOADER,
      length: 1,
      samples: faithfulSamples(sequence),
      observation: { mode: 'walked', reached: true, samples: walkedSamples() },
    }));
    const result = body(await tools.animation(
      { action: 'verify', model: 'game.Workspace.Guard', animation: wave(), animation_id: '2', slot: 'walk', position: [10, 0, 0] },
      'place:1',
    ));
    expect(calls).toEqual([{
      endpoint: '/api/animation-verify-model',
      data: { model: 'game.Workspace.Guard', animationId: 'rbxassetid://2', observe: 'walk', target: [10, 0, 0] },
      target: 'server',
      instance_id: 'place:1',
      timeoutMs: 60_000,
    }]);
    expect(result).toMatchObject({
      verified: true,
      model: 'game.Workspace.Guard',
      loader: { unchanged: true, states: { idle: IDLE, walk: WALK }, groundSpeeds: { walk: 4 } },
      played: { source: 'published', verified: true },
      wiring: { slot: 'walk', animationId: WALK, matches: true },
      movement: { verified: true, mode: 'walked', pace: { kept: true } },
    });
    expect(JSON.stringify(result)).not.toContain('"samples":[');
  });

  test('the animation or a slot alone checks only joints or wiring; with nothing else, the model is watched', async () => {
    const sequence = compiled(wave());
    const { tools, calls } = toolsAnswering((data) => (data.observe
      ? { loader: LOADER, observation: { mode: 'watched', samples: walkedSamples().map((sample) => ({ ...sample, phase: 'watching' })) } }
      : { rigType: 'R15', loader: LOADER, length: 1, samples: faithfulSamples(sequence) }));
    const played = body(await tools.animation({ action: 'verify', model: 'game.Workspace.Guard', animation: wave() }));
    expect(calls[0].data).toEqual({ model: 'game.Workspace.Guard', sequence: expect.objectContaining({ name: 'Wave', rig: 'R15' }) });
    expect(played).toMatchObject({ verified: true, played: { source: 'temporary clip' } });
    expect(played).not.toHaveProperty('movement');
    const watched = body(await tools.animation({ action: 'verify', model: 'game.Workspace.Guard' }));
    expect(calls[1].data).toEqual({ model: 'game.Workspace.Guard', observe: 'watch' });
    expect(watched).toMatchObject({ verified: true, movement: { mode: 'watched' } });
    // A slot alone reads the wiring, so a model that stands still is not failed for standing.
    const wired = body(await tools.animation({ action: 'verify', model: 'game.Workspace.Guard', slot: 'walk', animation_id: WALK }));
    expect(calls[2].data).toEqual({ model: 'game.Workspace.Guard' });
    expect(wired).toEqual({
      verified: true,
      model: 'game.Workspace.Guard',
      loader: { unchanged: true, states: LOADER.ids, groundSpeeds: LOADER.speeds },
      wiring: { slot: 'walk', animationId: WALK, matches: true },
    });
  });

  test('a state holding another ID, or a model of the other rig, is not verified', async () => {
    const { tools } = toolsAnswering(() => ({ loader: LOADER, observation: { mode: 'walked', reached: true, samples: walkedSamples() } }));
    const wrong = body(await tools.animation({ action: 'verify', model: 'game.Workspace.Guard', animation_id: '7', slot: 'walk', position: [1, 2, 3] }));
    expect(wrong).toMatchObject({ verified: false, wiring: { slot: 'walk', animationId: WALK, matches: false }, movement: { verified: true } });
    const r6 = toolsAnswering(() => ({ rigType: 'R6', loader: false, length: 1, samples: [] }));
    const mismatch = body(await r6.tools.animation({ action: 'verify', model: 'game.Workspace.Guard', animation: wave() }));
    expect(mismatch).toMatchObject({ errorCode: 'rig_mismatch', modelRig: 'R6' });
    expect(mismatch.error).toBe('game.Workspace.Guard is R6, but the animation is for R15, so it cannot play on it. Nothing was verified.');
  });

  test('says to start a playtest when there is no server to verify on', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    (tools as unknown as { _callSingle: unknown })._callSingle = async () => {
      throw new RoutingFailure({ code: 'target_role_not_present_on_instance', message: 'no server', data: { instances: [], count: 0 } });
    };
    expect(body(await tools.animation({ action: 'verify', model: 'game.Workspace.Guard' }))).toMatchObject({ errorCode: 'no_playtest' });
  });

  test('refuses what it cannot verify before Studio sees it', async () => {
    const { tools, calls } = toolsAnswering(() => ({}));
    const verify = (args: Record<string, unknown>) => tools.animation({ action: 'verify', model: 'game.Workspace.Guard', ...args });
    await expect(verify({ position: [1, 2] })).rejects.toThrow('position must be [x, y, z]: where to walk the model');
    await expect(verify({ position: [1, 2, Number.NaN] })).rejects.toThrow('position must be [x, y, z]');
    await expect(verify({ slot: 'walk' })).rejects.toThrow(/animation_id is required with slot/);
    await expect(verify({ slot: 'jump', animation_id: '1' })).rejects.toThrow(/with model, slot must be one of idle, walk, run/);
    expect(body(await verify({ animation: { ...wave(), keyframes: [] } }))).toMatchObject({ error: 'The animation is not valid; nothing was verified.' });
    expect(calls).toEqual([]);
  });
});

describe('an animation for a model\'s own rig', () => {
  type Call = { endpoint: string; data: Record<string, unknown>; target: unknown; instance_id?: string };
  /** A wag of the hand-rigged dog's tail with a nod, written with rotation only. */
  const wag = (rig = 'Workspace.Dog') => ({
    name: 'Wag',
    rig,
    loop: true,
    keyframes: [
      { time: 0, joints: { Neck: { rotation: [0, 0, 0] }, Tail: { rotation: [0, -30, 0] } } },
      { time: 0.4, joints: { Neck: { rotation: [15, 0, 0] }, Tail: { rotation: [0, 30, 0] } } },
      { time: 0.8, joints: { Neck: { rotation: [0, 0, 0] }, Tail: { rotation: [0, -30, 0] } } },
    ],
  });
  const dogRig = () => {
    const read = rigFromModel(partsDog());
    if (!read.ok) throw new Error(read.errors.join('\n'));
    return read.rig;
  };
  /** Studio answering from `answers`, by endpoint; the dog's rig is read as the fixture has it. */
  function studio(answers: Record<string, (data: Record<string, unknown>) => unknown> = {}) {
    const tools = new RobloxStudioTools(new BridgeService());
    const calls: Call[] = [];
    (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string, data: Record<string, unknown>, target: unknown, instance_id?: string) => {
      calls.push({ endpoint, data, target, instance_id });
      if (endpoint === '/api/animation-read-rig' && !answers[endpoint]) return partsDog();
      const answer = answers[endpoint];
      if (!answer) throw new Error(`unexpected call to ${endpoint}`);
      return answer(data);
    };
    return { tools, calls };
  }
  /** What a faithful copy of the dog would report: core's own sampler on its rig. */
  function dogSamples(sequence: KeyframeSequenceDescription, times = previewSampleTimes(sequence)): PreviewSample[] {
    const tracks = buildTracks(sequence);
    return times.map((time) => ({
      time,
      transforms: Object.fromEntries(dogRig().joints.map((joint) => {
        const frame = sampleTrack(tracks.get(joint.childPart), time);
        return [joint.childPart, [...frame.p, ...frame.r]];
      })),
    }));
  }

  test('check reads the rig from Studio, names its joints, and says what it could not check', async () => {
    const { tools, calls } = studio();
    const result = body(await tools.animation({ action: 'check', animation: wag() }, 'place-1'));
    expect(calls).toEqual([{ endpoint: '/api/animation-read-rig', data: { model: 'Workspace.Dog' }, target: undefined, instance_id: 'place-1' }]);
    expect(result).toMatchObject({
      valid: true,
      // Named as Studio names the model.
      animation: { name: 'Wag', rig: 'game.Workspace.Dog', joints: ['Neck', 'Tail'] },
      rig: {
        path: 'game.Workspace.Dog',
        revision: 'r1',
        joints: ['Root', 'Neck', 'FrontLeft', 'FrontRight', 'HindLeft', 'HindRight', 'Tail'],
        position: 'Root',
        ranged: [],
      },
      checks: { passed: true },
    });
    expect(result.rig.scale).toMatch(/^0\.66 times R15's distance limits, from its height at rest$/);
    const limits = result.checks.results.find((check: { id: string }) => check.id === 'jointLimits');
    expect(limits).toEqual({ id: 'jointLimits', status: 'skipped', detail: 'not checked: Neck and Tail turn with no declared range' });
    expect(result.sheet.rig).toBe('game.Workspace.Dog\'s own parts, each drawn as its shape, a block, wedge, cylinder or ball, or as its MeshPart\'s mesh, with the parts welded to it');
    expect(result.sheet).not.toHaveProperty('boxes');
    expect(result.sheet.reading).toContain('straight at its front, its right side on the left');
  });

  test('check names the joints when a pose keys one the rig does not have', async () => {
    const { tools } = studio();
    const typo = { ...wag(), keyframes: [{ time: 0, joints: { Tial: { rotation: [0, 10, 0] } } }] };
    const result = body(await tools.animation({ action: 'check', animation: typo }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/^keyframes\[0\]\.joints\.Tial: /);
    expect(result.rig.joints).toContain('Tail');
  });

  test('a rig Studio cannot read, or one core refuses, comes back as the reason, with nothing checked or built', async () => {
    const missing = studio({ '/api/animation-read-rig': () => ({ error: 'game.Workspace.Cat does not exist.', errorCode: 'model_not_found' }) });
    expect(body(await missing.tools.animation({ action: 'check', animation: wag('game.Workspace.Cat') }))).toEqual({
      valid: false,
      error: 'game.Workspace.Cat\'s rig could not be read: game.Workspace.Cat does not exist.',
      errorCode: 'model_not_found',
    });
    const repeated = studio({ '/api/animation-read-rig': () => ({ ...partsDog(), parts: [...partsDog().parts, { name: 'Head', size: [1, 1, 1] }] }) });
    const refused = body(await repeated.tools.animation({ action: 'build', animation: wag(), parent: 'game.ServerStorage' }));
    expect(refused).toMatchObject({
      error: 'Workspace.Dog\'s rig cannot be animated as it is. Nothing was built.',
      errorCode: 'invalid_rig',
      errors: ["parts: a keyframe's poses find their parts by name, so each must be named once; these repeat: Head"],
    });
    expect(repeated.calls.map((call) => call.endpoint)).toEqual(['/api/animation-read-rig']);
  });

  test('build previews on a copy of the model while its rig is as read, compares on its joints, and writes', async () => {
    const compiledWag = compilePoseAnimation({ ...wag(), rig: 'game.Workspace.Dog' }, dogRig());
    if (!compiledWag.ok) throw new Error(compiledWag.errors.join('\n'));
    const sequence = compiledWag.sequence;
    const { tools, calls } = studio({
      '/api/preview-animation': (data) => ({ length: 0.8, samples: dogSamples(sequence, data.sampleTimes as number[]) }),
      '/api/build-animation': () => ({
        path: 'game.ServerStorage.Wag', instanceRef: 'ref-1', revision: 'kr1:abc', stampMatches: true,
        replaced: false, keyframes: sequence.keyframes.length, poses: sequence.poseCount, undoable: true,
      }),
    });
    const result = body(await tools.animation({ action: 'build', animation: wag(), parent: 'game.ServerStorage' }, 'place-1'));
    // No stock meshes are read for a model's rig.
    expect(calls.map((call) => call.endpoint)).toEqual(['/api/animation-read-rig', '/api/preview-animation', '/api/build-animation']);
    expect(calls[1].data).toMatchObject({ model: { path: 'game.Workspace.Dog', revision: 'r1' }, sequence: { rig: 'game.Workspace.Dog' } });
    expect(calls[1].data).not.toHaveProperty('props');
    expect(result).toMatchObject({
      built: true,
      rig: { path: 'game.Workspace.Dog' },
      playback: { verified: true, samples: 8 },
      readBack: { matchesCompiled: true },
    });
  });

  test('build writes nothing when the rig changed since it was read', async () => {
    const { tools, calls } = studio({
      '/api/preview-animation': () => ({ error: 'game.Workspace.Dog\'s rig has changed since the animation was checked against it; check it again.', errorCode: 'stale_rig' }),
    });
    const result = body(await tools.animation({ action: 'build', animation: wag(), parent: 'game.ServerStorage' }));
    expect(result).toEqual({
      error: 'Studio could not preview the animation: game.Workspace.Dog\'s rig has changed since the animation was checked against it; check it again. Nothing was built.',
      errorCode: 'stale_rig',
    });
    expect(calls.map((call) => call.endpoint)).not.toContain('/api/build-animation');
  });

  test('check reads the meshes of its MeshParts once, and names those drawn as boxes with why', async () => {
    const tetrahedron = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      normals: [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, -1, 0, 0, -1, 0, 0, -1, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      min: [0, 0, 0],
      max: [1, 1, 1],
    };
    const reading = {
      ...partsDog(),
      parts: partsDog().parts.map((part) => (part.name === 'Head' ? { ...part, mesh: 'rbxassetid://31' } : part.name === 'Tail' ? { ...part, mesh: 'rbxassetid://32' } : part)),
    };
    const { tools, calls } = studio({
      '/api/animation-read-rig': () => reading,
      '/api/animation-read-meshes': () => ({ meshes: { 'rbxassetid://31': tetrahedron, 'rbxassetid://32': { error: 'Studio would not hand it over: not permitted' } } }),
    });
    const first = body(await tools.animation({ action: 'check', animation: wag() }));
    expect(calls.map((call) => call.endpoint)).toEqual(['/api/animation-read-rig', '/api/animation-read-meshes']);
    expect(calls[1].data).toEqual({ meshes: ['rbxassetid://31', 'rbxassetid://32'] });
    expect(first.sheet.boxes).toBe('MeshParts drawn as their boxes: Tail (Studio would not hand it over: not permitted)');
    // Kept, and refused, for this process: the next check reads the rig alone.
    const second = body(await tools.animation({ action: 'check', animation: wag() }));
    expect(calls.map((call) => call.endpoint).slice(2)).toEqual(['/api/animation-read-rig']);
    expect(second.sheet.boxes).toBe(first.sheet.boxes);
  });

  test('verify compares the model\'s playtest with its own rig, and a character is not asked to play it', async () => {
    const compiledWag = compilePoseAnimation({ ...wag(), rig: 'game.Workspace.Dog' }, dogRig());
    if (!compiledWag.ok) throw new Error(compiledWag.errors.join('\n'));
    const sequence = compiledWag.sequence;
    // The dog's Humanoid reports R15, as a Humanoid does, which says nothing about its own rig.
    const { tools, calls } = studio({
      '/api/animation-verify-model': () => ({ rigType: 'R15', loader: false, length: 0.8, samples: dogSamples(sequence, [0.1, 0.3, 0.5]) }),
    });
    const result = body(await tools.animation({ action: 'verify', model: 'game.Workspace.Dog', animation: wag() }));
    expect(calls.map((call) => [call.endpoint, call.target])).toEqual([['/api/animation-read-rig', undefined], ['/api/animation-verify-model', 'server']]);
    expect(result).toMatchObject({ verified: true, played: { source: 'temporary clip', verified: true, samples: 3 } });
    const character = studio();
    expect(body(await character.tools.animation({ action: 'verify', animation: wag() }))).toEqual({
      error: 'This animation is for Workspace.Dog\'s own rig, not a player\'s character; verify it on that model, with model. Nothing was verified.',
      errorCode: 'rig_mismatch',
    });
    expect(character.calls).toEqual([]);
  });
});

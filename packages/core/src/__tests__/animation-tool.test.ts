import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeService } from '../bridge-service.js';

// A cache of real rig meshes on this machine must not change what the tests draw.
process.env.ROBLOXSTUDIO_MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'roqer-rig-cache-'));
import { RobloxStudioTools } from '../tools/index.js';
import {
  PREVIEW_SAMPLES,
  choosePublisher,
  normalizeAnimationId,
  prepareAnimation,
  previewSampleTimes,
  verifyLivePlayback,
  verifyPlayback,
  type PreviewSample,
} from '../animation/animation-tool.js';
import { buildTracks, sampleTrack } from '../animation/motion.js';
import { compilePoseAnimation, type KeyframeSequenceDescription } from '../animation/pose-compiler.js';
import { R15_RIG } from '../animation/r15-rig.js';

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
    transforms: Object.fromEntries(R15_RIG.joints.map((joint) => {
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
    const result = prepareAnimation({ ...wave(), rig: 'R6' }, { locomotion: 'yes', waive: ['gait', 'velocity'] });
    expect(result).toEqual({
      ok: false,
      errors: [
        'locomotion: must be true or false',
        'waive: unknown check "gait"; checks are jointLimits, velocity, rootDrift, loopContinuity, groundContact, footSliding, gaitSymmetry',
        'rig: must be one of R15',
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

  test('check shows the motion: a contact sheet for the model and a GLB for the viewer', async () => {
    const { tools } = toolsWith({});
    const result = await tools.animation({ action: 'check', animation: wave() });
    const [text, image, resource] = result.content as ToolContent[];
    expect(JSON.parse(text.text!).sheet).toMatchObject({ times: [0, 0.2, 0.4, 0.6, 0.8] });
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const png = Buffer.from(image.data!, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([860, 508]);
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
    await expect(tools.animation({ action: 'play', animation: wave() })).rejects.toThrow('animation action must be check, build, publish, wire or verify');
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

  test('given only a path, asks for the checked animation and calls nothing', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const calls: string[] = [];
    (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string) => { calls.push(endpoint); return {}; };
    const result = body(await tools.animation({ action: 'verify', path: 'game.ServerStorage.Run' }));
    expect(result.error).toMatch(/pass the same animation you checked and built, not only its path/);
    expect(calls).toEqual([]);
  });
});

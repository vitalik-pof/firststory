import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import { ElevenLabsClient } from '../lib/elevenlabs';
import { updateManifest } from '../lib/manifest';
import { V4_OBSERVED_CREDITS_PER_CHAR, estimateTts, ttsRate } from '../lib/pricing';
import { STORY, mkProject } from './fixtures';

describe('ціна озвучення', () => {
  before(() => void mkProject());
  const client = new ElevenLabsClient({ apiKey: undefined, baseUrl: 'http://127.0.0.1:1' });

  it('без вимірювань: спостережена 0.485 як «оцінка», а не 1 «з API»', async () => {
    const r = await ttsRate(new ElevenLabsClient({ apiKey: '' }), 'eleven_v4', STORY);
    assert.equal(r.source, 'оцінка');
    assert.ok(Math.abs(r.multiplier - 0.485) < 0.001);
    assert.equal(estimateTts(1999, r).credits, 970);
    void client; void V4_OBSERVED_CREDITS_PER_CHAR; void writeFileSync;
  });

  it('виміряне в маніфесті має перевагу, а частини з лічильника (не з історії) не рахуються', async () => {
    updateManifest(STORY, (m) => {
      m.narration = { parts: { a: { chars_sent: 88, credits: 43, credits_source: 'history' }, b: { chars_sent: 1911, credits: 927, credits_source: 'history' }, c: { chars_sent: 500, credits: 999, credits_source: 'counter' } } };
    });
    const r = await ttsRate(new ElevenLabsClient({ apiKey: '' }), 'eleven_v4', STORY);
    assert.equal(r.source, 'виміряно в маніфесті');
    assert.ok(Math.abs(r.multiplier - 970 / 1999) < 1e-9);
    assert.equal(estimateTts(1000, r).source, 'виміряно в маніфесті');
  });
});

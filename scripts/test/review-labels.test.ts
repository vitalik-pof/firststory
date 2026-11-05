import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { imageLabel } from '../lib/review-html';

describe('підписи ключів manifest.images в огляді', () => {
  it('поточні кадри, аркуші й зразки', () => {
    assert.equal(imageLabel('frame/07'), 'Кадр 7');
    assert.equal(imageLabel('sheet/natalia'), 'Аркуш natalia');
    assert.equal(imageLabel('sample/02'), 'Зразок 2');
  });
  it('кадри архіву попередньої розкадровки', () => {
    assert.equal(imageLabel('frame-v3/05'), 'Кадр 5, розкадровка v3 (архів)');
  });
  it('незнайомий ключ лишається як є', () => {
    assert.equal(imageLabel('dropped/v4-frame-01'), 'dropped/v4-frame-01');
    assert.ok(!/NaN/.test(imageLabel('щось/інше')));
  });
});

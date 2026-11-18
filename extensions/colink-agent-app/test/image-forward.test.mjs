import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FORWARD_IMAGES_PER_TURN, extractSvgBlocks, svgToPng } from '../src/image-forward.mjs';

const RED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>';

test('extractSvgBlocks pulls fenced svg blocks and strips them from the text', () => {
  const { svgs, text } = extractSvgBlocks(`开头\n\`\`\`svg\n${RED_SVG}\n\`\`\`\n结尾`);
  assert.equal(svgs.length, 1);
  assert.equal(svgs[0], RED_SVG);
  assert.equal(text, '开头\n\n结尾');
});

test('extractSvgBlocks caps at MAX_FORWARD_IMAGES_PER_TURN and dedupes', () => {
  const svgOf = fill => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="${fill}"/></svg>`;
  const fenced = s => `\`\`\`svg\n${s}\n\`\`\``;
  const source = [svgOf('red'), svgOf('blue'), svgOf('green')].map(fenced).join('\n');
  const { svgs } = extractSvgBlocks(source);
  assert.equal(svgs.length, 2);
  assert.equal(svgs[0], svgOf('red'));
  assert.equal(svgs[1], svgOf('blue'));
  // 重复块去重
  const { svgs: deduped } = extractSvgBlocks([fenced(RED_SVG), fenced(RED_SVG)].join('\n'));
  assert.equal(deduped.length, 1);
});

test('extractSvgBlocks falls back to a bare <svg> block without a fence', () => {
  const { svgs, text } = extractSvgBlocks(`说明\n${RED_SVG}\n完毕`);
  assert.equal(svgs.length, 1);
  assert.equal(svgs[0], RED_SVG);
  assert.equal(text, '说明\n\n完毕');
});

test('extractSvgBlocks returns empty svgs for plain text', () => {
  const { svgs, text } = extractSvgBlocks('没有图片的普通回复');
  assert.deepEqual(svgs, []);
  assert.equal(text, '没有图片的普通回复');
});

test('svgToPng renders an SVG to PNG bytes', async () => {
  const bytes = await svgToPng(RED_SVG);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.length > 8);
  // PNG magic number
  assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

// 文案坍缩的机器可检部分：骨架重合。改阈值前先用真实归档回放，确认正常改写不被误伤。
import test from 'node:test';
import assert from 'node:assert/strict';
import { skeleton, skeletonSimilarity, findSkeletonDuplicates } from '../scripts/text-lint.mjs';

test('skeleton：数字归一为 #，标点与空白被剔除', () => {
  assert.equal(skeleton('17 期累计 6388 kcal，达标 15 期。'), skeleton('18 期累计 7000 kcal 达标 16 期'));
});

test('骨架相似度：只换数字 = 1.0（这就是模式坍缩的形状）', () => {
  const a = '17 期累计 6388 kcal；跳操 23 次+练背 16 次双主线，达标 15 期、周均 376 kcal。';
  const b = '18 期累计 7000 kcal；跳操 25 次+练背 17 次双主线，达标 16 期、周均 400 kcal。';
  assert.ok(skeletonSimilarity(a, b) >= 0.8, `实际 ${skeletonSimilarity(a, b).toFixed(2)}`);
});

test('骨架相似度：换了角度就低于告警线', () => {
  const a = '力训当底子，出勤几乎没断，15 连击是群里现存最长的。';
  const b = '爵士舞占了六成，练得专，可 17 期只有 8 期达标。';
  assert.ok(skeletonSimilarity(a, b) < 0.65, `实际 ${skeletonSimilarity(a, b).toFixed(2)}`);
});

test('findSkeletonDuplicates：分档为「报错 / 告警」两级', () => {
  const items = [
    { key: '甲·full', text: '17 期累计 6388 kcal；跳操 23 次+练背 16 次双主线，达标 15 期、周均 376 kcal。' },
    { key: '乙·full', text: '18 期累计 7000 kcal；跳操 25 次+练背 17 次双主线，达标 16 期、周均 400 kcal。' },
    { key: '丙·full', text: '力训当底子，出勤几乎没断，15 连击是群里现存最长的。' },
  ];
  const { copied, similar } = findSkeletonDuplicates(items);
  assert.equal(copied.length, 1);
  assert.equal(copied[0].a, '甲·full');
  assert.ok(copied[0].sim >= 0.8);
  assert.equal(similar.length, 0, '无关文案不该进告警');
});

test('findSkeletonDuplicates：各自不同的文案不产生任何命中', () => {
  const items = [
    { key: 'a', text: '几乎只做瑜伽一件事，出勤却被五次空窗切碎。' },
    { key: 'b', text: '散步跳操两条腿走路，52 次打卡是群里最勤的那双手。' },
    { key: 'c', text: '伤愈归队后一路往上爬，最近几周明显跑在自己的平均线之上。' },
  ];
  const { copied, similar } = findSkeletonDuplicates(items);
  assert.equal(copied.length, 0);
  assert.equal(similar.length, 0);
});

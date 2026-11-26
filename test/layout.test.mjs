import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceOf, autoMode, autoFontSize } from '../app/js/layout.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const WECHAT = IPHONE + ' MicroMessenger/8.0.50';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
const DESK = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36';

test('deviceOf 区分手机、平板与桌面', () => {
  assert.equal(deviceOf({ width: 390, height: 844, touch: true, ua: IPHONE }), 'phone');
  assert.equal(deviceOf({ width: 844, height: 390, touch: true, ua: IPHONE }), 'phone');
  assert.equal(deviceOf({ width: 820, height: 1180, touch: true, ua: IPAD }), 'tablet');
  assert.equal(deviceOf({ width: 1440, height: 900, touch: false, ua: DESK }), 'desktop');
});

test('autoMode：竖屏手机、平板、宽窗口左右翻页', () => {
  assert.equal(autoMode({ width: 390, height: 844, touch: true, ua: IPHONE }).mode, 'paged');
  assert.equal(autoMode({ width: 820, height: 1180, touch: true, ua: IPAD }).mode, 'paged');
  assert.equal(autoMode({ width: 1440, height: 900, touch: false, ua: DESK }).mode, 'paged');
});

test('autoMode：横屏手机、窄窗口、矮窗口、应用内浏览器、小屏 PDF 上下滑动', () => {
  assert.equal(autoMode({ width: 844, height: 390, touch: true, ua: IPHONE }).mode, 'scroll');
  assert.equal(autoMode({ width: 480, height: 900, touch: false, ua: DESK }).mode, 'scroll');
  assert.equal(autoMode({ width: 1200, height: 380, touch: false, ua: DESK }).mode, 'scroll');
  assert.equal(autoMode({ width: 390, height: 844, touch: true, ua: WECHAT }).mode, 'scroll');
  assert.equal(autoMode({ width: 412, height: 915, touch: true, ua: ANDROID, kind: 'pdf' }).mode, 'scroll');
  assert.equal(autoMode({ width: 412, height: 915, touch: true, ua: ANDROID, kind: 'flow' }).mode, 'paged');
});

test('autoFontSize 随设备与窗口变化，且在 14–30 之间', () => {
  assert.equal(autoFontSize({ width: 375, height: 667, touch: true, ua: IPHONE }), 18);
  assert.equal(autoFontSize({ width: 320, height: 568, touch: true, ua: IPHONE }), 17);
  assert.equal(autoFontSize({ width: 820, height: 1180, touch: true, ua: IPAD }), 20);
  assert.equal(autoFontSize({ width: 1024, height: 768, touch: false, ua: DESK }), 19);
  assert.equal(autoFontSize({ width: 1920, height: 1080, touch: false, ua: DESK }), 21);
  assert.equal(autoFontSize({ width: 2560, height: 1440, touch: false, ua: DESK }), 22);
  assert.equal(autoFontSize({ width: 1920, height: 500, touch: false, ua: DESK }), 20);
  for (const w of [200, 600, 1000, 4000]) { const f = autoFontSize({ width: w, height: 800, touch: w < 700 }); assert.ok(f >= 14 && f <= 30); }
});

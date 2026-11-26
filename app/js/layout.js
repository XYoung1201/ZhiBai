// 自动排版：按设备类型、浏览器与窗口大小决定「左右翻页 / 上下滑动」以及正文字号。
// 纯函数，不碰 DOM；env 由调用方从 window 取来，便于测试。

// 应用内置浏览器（微信、QQ、微博、钉钉、飞书、Facebook、Instagram、Line…）的左右滑动常被宿主当成返回手势
const IN_APP = /MicroMessenger|\bQQ\/|MQQBrowser.*\bQQ|Weibo|DingTalk|Lark|Feishu|FBAN|FBAV|Instagram|\bLine\//i;

export function deviceOf({ width, height, touch, ua = '' }) {
  const short = Math.min(width, height), long = Math.max(width, height);
  if (touch && (short < 600 || /iPhone|Android.+Mobile/i.test(ua))) return 'phone';
  if (touch && long <= 1400) return 'tablet';
  return 'desktop';
}

// 返回 { mode: 'paged' | 'scroll', why }
export function autoMode({ width, height, touch, ua = '', kind = 'flow' }) {
  const device = deviceOf({ width, height, touch, ua });
  if (IN_APP.test(ua)) return { mode: 'scroll', why: '应用内浏览器' };
  if (device === 'phone' && width > height && height < 500) return { mode: 'scroll', why: '手机横屏' };
  if (kind === 'pdf' && width < 600) return { mode: 'scroll', why: '小屏看 PDF' };
  if (device === 'desktop' && width < 560) return { mode: 'scroll', why: '窄窗口' };
  if (height < 420) return { mode: 'scroll', why: '窗口太矮' };
  return { mode: 'paged', why: device === 'phone' ? '手机竖屏' : device === 'tablet' ? '平板' : '宽窗口' };
}

// 正文字号（px）：手机 18 起，平板 20，桌面随窗口宽度 19–22；窗口很矮时小一号
export function autoFontSize({ width, height, touch, ua = '' }) {
  const device = deviceOf({ width, height, touch, ua });
  let fs;
  if (device === 'phone') fs = width < 360 ? 17 : width < 414 ? 18 : 19;
  else if (device === 'tablet') fs = width < 900 ? 20 : 21;
  else fs = width < 1100 ? 19 : width < 1600 ? 20 : width < 2200 ? 21 : 22;
  if (height < 560) fs -= 1;
  return Math.max(14, Math.min(30, fs));
}

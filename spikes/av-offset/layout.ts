/**
 * 录像画面里的测量区域：由 OBS 场景项的变换算出 Stage 源的字幕带与形象源的范围（画布像素），
 * 再按录像分辨率缩放。只处理不旋转、不翻转的场景项；其它情况由调用方手工给出区域。
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** obs-websocket 5 的 GetSceneItemTransform 应答里用到的字段。 */
export interface SceneItemTransform {
  positionX: number;
  positionY: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  alignment: number;
  boundsType: string;
  boundsAlignment: number;
  boundsWidth: number;
  boundsHeight: number;
  cropLeft: number;
  cropRight: number;
  cropTop: number;
  cropBottom: number;
  sourceWidth: number;
  sourceHeight: number;
}

/** 来源像素到画布像素：canvas = origin + (source - crop) * scale。 */
export interface Placement {
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
  /** 来源中可见（裁剪后）的部分，来源像素。 */
  visible: Rect;
}

const ALIGN_LEFT = 1;
const ALIGN_RIGHT = 2;
const ALIGN_TOP = 4;
const ALIGN_BOTTOM = 8;

/** 对齐方式在一个方向上的比例：左（上）为 0，右（下）为 1，居中为 0.5。 */
function fraction(alignment: number, low: number, high: number): number {
  if (alignment & low) return 0;
  if (alignment & high) return 1;
  return 0.5;
}

export function placement(t: SceneItemTransform): Placement {
  if (t.rotation % 360 !== 0) throw new Error(`场景项旋转了 ${t.rotation}°，请手工给出区域`);
  if (t.scaleX <= 0 || t.scaleY <= 0) throw new Error('场景项被翻转，请手工给出区域');
  const visible = {
    x: t.cropLeft,
    y: t.cropTop,
    w: t.sourceWidth - t.cropLeft - t.cropRight,
    h: t.sourceHeight - t.cropTop - t.cropBottom,
  };
  if (visible.w <= 0 || visible.h <= 0) throw new Error('场景项裁剪后没有可见部分');
  let scaleX = t.scaleX;
  let scaleY = t.scaleY;
  // 无外框时对齐方式作用于内容本身；有外框时作用于外框，内容再按外框内的对齐方式摆放。
  let boxW = visible.w * scaleX;
  let boxH = visible.h * scaleY;
  let insetX = 0;
  let insetY = 0;
  if (t.boundsType !== 'OBS_BOUNDS_NONE') {
    const fitW = t.boundsWidth / visible.w;
    const fitH = t.boundsHeight / visible.h;
    switch (t.boundsType) {
      case 'OBS_BOUNDS_STRETCH':
        [scaleX, scaleY] = [fitW, fitH];
        break;
      case 'OBS_BOUNDS_SCALE_INNER':
        scaleX = scaleY = Math.min(fitW, fitH);
        break;
      case 'OBS_BOUNDS_SCALE_OUTER':
        scaleX = scaleY = Math.max(fitW, fitH);
        break;
      case 'OBS_BOUNDS_SCALE_TO_WIDTH':
        scaleX = scaleY = fitW;
        break;
      case 'OBS_BOUNDS_SCALE_TO_HEIGHT':
        scaleX = scaleY = fitH;
        break;
      case 'OBS_BOUNDS_MAX_ONLY':
        scaleX = scaleY = Math.min(1, fitW, fitH);
        break;
      default:
        throw new Error(`未知的外框类型 ${t.boundsType}，请手工给出区域`);
    }
    insetX = (t.boundsWidth - visible.w * scaleX) * fraction(t.boundsAlignment, 1, 2);
    insetY = (t.boundsHeight - visible.h * scaleY) * fraction(t.boundsAlignment, 4, 8);
    boxW = t.boundsWidth;
    boxH = t.boundsHeight;
  }
  const left = t.positionX - boxW * fraction(t.alignment, ALIGN_LEFT, ALIGN_RIGHT) + insetX;
  const top = t.positionY - boxH * fraction(t.alignment, ALIGN_TOP, ALIGN_BOTTOM) + insetY;
  return {
    originX: left - visible.x * scaleX,
    originY: top - visible.y * scaleY,
    scaleX,
    scaleY,
    visible,
  };
}

/** 来源里的一块（来源像素，先按可见部分裁剪）在画布上的位置。 */
export function toCanvas(p: Placement, rect: Rect): Rect | null {
  const clipped = intersect(rect, p.visible);
  if (!clipped) return null;
  return {
    x: p.originX + clipped.x * p.scaleX,
    y: p.originY + clipped.y * p.scaleY,
    w: clipped.w * p.scaleX,
    h: clipped.h * p.scaleY,
  };
}

/** 场景项在画布上的可见范围。 */
export function itemRect(p: Placement): Rect {
  return toCanvas(p, p.visible) as Rect;
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}

/** 从画布像素缩放到录像像素，向外取整到整像素并裁到画面内。 */
export function toVideo(
  rect: Rect,
  canvas: { width: number; height: number },
  video: { width: number; height: number },
): Rect | null {
  const sx = video.width / canvas.width;
  const sy = video.height / canvas.height;
  const x0 = Math.max(0, Math.floor(rect.x * sx));
  const y0 = Math.max(0, Math.floor(rect.y * sy));
  const x1 = Math.min(video.width, Math.ceil((rect.x + rect.w) * sx));
  const y1 = Math.min(video.height, Math.ceil((rect.y + rect.h) * sy));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** 与 packages/stage/page/stage.css 中 #subtitle 的布局一致：左右各 5%、底边 6%、44px 字号、1.4 倍行高。 */
const SUBTITLE = { side: 0.05, bottom: 0.06, fontPx: 44, lineHeight: 1.4, shadowPx: 8 };

/** 一句字幕按 44px 等宽的汉字估算的行数（页面宽度为浏览器源的宽）。 */
export function subtitleLines(chars: number, pageWidth: number): number {
  const perLine = Math.max(1, Math.floor((pageWidth * (1 - 2 * SUBTITLE.side)) / SUBTITLE.fontPx));
  return Math.max(1, Math.ceil(chars / perLine));
}

/**
 * 字幕带（来源像素）：最多 lines 行字幕可能占到的范围，四周留出文字阴影的余量。
 * 页面宽高即浏览器源的宽高（场景项变换里的 sourceWidth、sourceHeight）。
 */
export function subtitleBand(pageWidth: number, pageHeight: number, lines: number): Rect {
  const margin = SUBTITLE.shadowPx + 4;
  const bottom = pageHeight * (1 - SUBTITLE.bottom);
  const top = bottom - lines * SUBTITLE.fontPx * SUBTITLE.lineHeight;
  const band = {
    x: pageWidth * SUBTITLE.side - margin,
    y: top - margin,
    w: pageWidth * (1 - 2 * SUBTITLE.side) + 2 * margin,
    h: bottom - top + 2 * margin,
  };
  return intersect(band, { x: 0, y: 0, w: pageWidth, h: pageHeight }) as Rect;
}

/** 字幕一行（来源像素）：居中、第 line 行（从上往下，0 起），用于合成自检画面。 */
export function subtitleLineBox(
  pageWidth: number,
  pageHeight: number,
  chars: number,
  line: number,
  lines: number,
): Rect {
  const lineH = SUBTITLE.fontPx * SUBTITLE.lineHeight;
  const bottom = pageHeight * (1 - SUBTITLE.bottom);
  const width = Math.min(pageWidth * (1 - 2 * SUBTITLE.side), chars * SUBTITLE.fontPx);
  return {
    x: (pageWidth - width) / 2,
    y: bottom - (lines - line) * lineH + (lineH - SUBTITLE.fontPx) / 2,
    w: width,
    h: SUBTITLE.fontPx,
  };
}

export function parseRect(text: string): Rect {
  const parts = text.split(',').map(Number);
  const [x, y, w, h] = parts;
  if (
    parts.length !== 4 ||
    x === undefined ||
    y === undefined ||
    w === undefined ||
    h === undefined ||
    parts.some((v) => !Number.isFinite(v)) ||
    w <= 0 ||
    h <= 0
  )
    throw new Error(`区域应写成 x,y,w,h：${text}`);
  return { x, y, w, h };
}

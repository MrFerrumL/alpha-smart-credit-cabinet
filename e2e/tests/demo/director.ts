import { expect, type Locator, type Page } from '@playwright/test';

import type { Actor } from '../helpers';

// Режиссёр записи демо: точка-курсор, подписи и темп. В видео Playwright указателя мыши нет, а locator.click()
// переносит мышь и нажимает одной пачкой — страница реагирует раньше, чем точка успевает долететь. Поэтому точку
// двигает только сам сценарий: сначала плавный перелёт к центру элемента, потом туда же настоящая мышь, короткая
// остановка, нажатие с видимой паузой между «нажал» и «отпустил». Подписи держатся столько, сколько нужно на чтение,
// и уходят до следующего действия.

/** Темп записи: все паузы — здесь, длительность видео подбирается этими числами. */
export const PACE = {
  /** Перелёт курсора: 250 мс + 0,55 мс на пиксель, но не короче 350 и не дольше 900 мс. */
  glide: { base: 250, perPx: 0.55, min: 350, max: 900 },
  /** Курсор замирает на элементе перед нажатием. */
  rest: 220,
  /** Между «нажал» и «отпустил» — чтобы нажатие было видно. */
  press: 120,
  /** Пауза после нажатия: видно, что изменилось на экране. */
  after: 650,
  /** Набор текста по знакам и кода по цифрам. */
  key: 90,
  digit: 220,
  /** Пауза после набора. */
  typed: 400,
  /** Время на чтение подписи: 900 мс + 55 мс на знак, от 2,5 до 6,5 с. */
  dwell: { base: 900, perChar: 55, min: 2500, max: 6500 },
} as const;

/** Нижняя полоса экрана, которую занимает подпись: блок, о котором подпись, прокручивается выше неё. */
const CAPTION_INSET = 130;

/** Сколько держать подпись на экране, чтобы её успели прочитать. */
export function dwell(text: string): number {
  const { base, perChar, min, max } = PACE.dwell;
  return Math.min(max, Math.max(min, base + perChar * text.length));
}

/** Нажатие мыши, как его увидела страница: где нажали, где была точка-курсор и долетела ли она до элемента. */
export interface Press {
  /** Мс от начала записи. */
  at: number;
  x: number;
  y: number;
  cursorX: number;
  cursorY: number;
  /** Сколько мс точка стояла на месте перед нажатием. */
  rest: number | null;
  /** Перед нажатием был перелёт точки ровно в эту точку. */
  glided: boolean;
  target: string;
}

export type Entry =
  | {
      kind: 'beat';
      caption: string;
      chars: number;
      /** Сколько подпись держится по расчёту (dwell + extra). */
      dwell: number;
      start: number;
      shown: number;
      end: number;
      until?: string;
      untilAt?: number;
    }
  | { kind: 'click' | 'hover' | 'type' | 'hold'; target: string; glide: number; start: number; end: number };

export interface Director {
  readonly t0: number;
  readonly presses: Press[];
  readonly timeline: Entry[];
}

type Glide = (typeof PACE)['glide'];

interface DemoApi {
  glide(x: number, y: number, pace: Glide): Promise<number>;
  caption(text: string): void;
  clear(): Promise<void>;
  reveal(el: Element, inset: number): boolean;
  still(el: Element | null, timeout: number): Promise<void>;
}

type RawPress = Omit<Press, 'at'> & { t: number };
type DemoWindow = Window & { __demo?: DemoApi; __demoPress?: (press: RawPress) => Promise<void> };

const directors = new WeakMap<Page, Director>();

function director(page: Page): Director {
  const d = directors.get(page);
  if (!d) throw new Error('Сначала installDirector(page)');
  return d;
}

const since = (d: Director) => Date.now() - d.t0;

/**
 * Слой поверх страницы: точка-курсор и подпись. Ставится в каждый новый документ до скриптов страницы, появляется на
 * DOMContentLoaded; положение точки переживает переходы (sessionStorage).
 */
function overlay(): void {
  if (window.top !== window) return;
  const KEY = 'potok.demo.cursor';
  const w = window as DemoWindow;
  const state = { x: 640, y: 360, arrivedAt: 0, glide: null as null | { x: number; y: number; used: boolean } };
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as { x: number; y: number } | null;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) Object.assign(state, { x: saved.x, y: saved.y });
  } catch {
    /* без sessionStorage точка начнёт с середины экрана */
  }

  let cursor: HTMLDivElement | null = null;
  let dot: HTMLDivElement | null = null;
  let caption: HTMLDivElement | null = null;
  let label: HTMLSpanElement | null = null;
  let press: Animation | null = null;
  const translate = (x: number, y: number) => `translate(${x}px, ${y}px)`;

  const ensure = (): boolean => {
    if (!document.body) return false;
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.id = 'demo-cursor';
      cursor.setAttribute('aria-hidden', 'true');
      Object.assign(cursor.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: '0',
        height: '0',
        zIndex: '2147483647',
        pointerEvents: 'none',
        transform: translate(state.x, state.y),
      });
      dot = document.createElement('div');
      Object.assign(dot.style, {
        position: 'absolute',
        left: '-11px',
        top: '-11px',
        width: '22px',
        height: '22px',
        boxSizing: 'border-box',
        borderRadius: '50%',
        background: 'rgba(239, 49, 36, 0.55)',
        border: '2px solid #ef3124',
        // Белый ободок — чтобы точку было видно и на красной кнопке.
        boxShadow: '0 0 0 2px rgba(255, 255, 255, 0.9), 0 2px 8px rgba(0, 0, 0, 0.3)',
      });
      cursor.append(dot);
    }
    if (!caption) {
      caption = document.createElement('div');
      caption.id = 'demo-caption';
      caption.setAttribute('aria-hidden', 'true');
      Object.assign(caption.style, {
        position: 'fixed',
        left: '24px',
        right: '24px',
        bottom: '28px',
        display: 'flex',
        justifyContent: 'center',
        zIndex: '2147483646',
        pointerEvents: 'none',
        opacity: '0',
      });
      label = document.createElement('span');
      Object.assign(label.style, {
        maxWidth: '1000px',
        textAlign: 'center',
        font: '600 20px/1.35 system-ui, "Segoe UI", Roboto, sans-serif',
        color: '#fff',
        background: 'rgba(17, 24, 39, 0.9)',
        padding: '12px 22px',
        borderRadius: '14px',
        boxShadow: '0 6px 24px rgba(0, 0, 0, 0.3)',
      });
      caption.append(label);
    }
    if (!caption.isConnected) document.body.append(caption);
    if (!cursor.isConnected) document.body.append(cursor);
    return true;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => ensure(), { once: true });
  else ensure();

  const frames = (n: number) =>
    new Promise<void>((resolve) => {
      const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });

  const describe = (el: Element) => {
    const t = el.closest('button, a, input, label, [role], tr') ?? el;
    const name = (t.getAttribute('aria-label') ?? (t instanceof HTMLElement ? t.innerText : '')).replace(/\s+/g, ' ').trim();
    return `${t.tagName.toLowerCase()}${name ? ` «${name.slice(0, 48)}»` : ''}`;
  };

  const api: DemoApi = {
    async glide(x, y, pace) {
      ensure();
      const distance = Math.hypot(x - state.x, y - state.y);
      const ms = distance < 2 ? 0 : Math.round(Math.min(pace.max, Math.max(pace.min, pace.base + pace.perPx * distance)));
      if (cursor) {
        const from = translate(state.x, state.y);
        cursor.style.transform = translate(x, y);
        if (ms > 0) {
          const anim = cursor.animate([{ transform: from }, { transform: translate(x, y) }], {
            duration: ms,
            easing: 'cubic-bezier(0.45, 0, 0.2, 1)',
          });
          await Promise.race([anim.finished.catch(() => undefined), new Promise((r) => setTimeout(r, ms + 500))]);
        }
      }
      Object.assign(state, { x, y, arrivedAt: Date.now(), glide: { x, y, used: false } });
      try {
        sessionStorage.setItem(KEY, JSON.stringify({ x, y }));
      } catch {
        /* положение не сохранится до следующего документа — не страшно */
      }
      await frames(2);
      return ms;
    },
    caption(text) {
      if (!ensure() || !caption || !label) return;
      label.textContent = text;
      caption.getAnimations().forEach((a) => a.cancel());
      caption.dataset.shown = 'true';
      caption.style.opacity = '1';
      caption.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], {
        duration: 240,
        easing: 'ease-out',
      });
    },
    async clear() {
      if (!caption || caption.dataset.shown !== 'true') return;
      caption.dataset.shown = 'false';
      caption.getAnimations().forEach((a) => a.cancel());
      caption.style.opacity = '0';
      await caption.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-in' }).finished.catch(() => undefined);
    },
    reveal(el, inset) {
      const r = el.getBoundingClientRect();
      const top = 8;
      const bottom = innerHeight - inset;
      const outside = r.top < top || r.bottom > bottom;
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        if (!/(auto|scroll)/.test(getComputedStyle(p).overflowY) || p.scrollHeight <= p.clientHeight) continue;
        const c = p.getBoundingClientRect();
        if (r.top < c.top || r.bottom > c.bottom) clipped = true;
      }
      if (!outside && !clipped) return false;
      // Спрятан во внутреннем списке (выпадающий список профилей) — ровно до края списка.
      if (clipped) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return true;
      }
      // Вне экрана — к середине полосы над подписью; блок выше полосы — верхним краем к верху экрана.
      const delta = r.height > bottom - top - 16 ? r.top - top - 8 : r.top + r.height / 2 - (top + bottom) / 2;
      if (Math.abs(delta) < 2) return false;
      window.scrollBy({ top: delta, behavior: 'smooth' });
      return true;
    },
    still(el, timeout) {
      return new Promise<void>((resolve) => {
        const started = performance.now();
        let last = '';
        let same = 0;
        const tick = () => {
          const r = el?.getBoundingClientRect();
          const key = `${Math.round(scrollX)},${Math.round(scrollY)},${r ? `${Math.round(r.left)},${Math.round(r.top)}` : ''}`;
          same = key === last ? same + 1 : 0;
          last = key;
          if (same >= 6 || performance.now() - started > timeout) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
  };
  w.__demo = api;

  // Нажатие видно: точка сжимается, от неё расходится кольцо. Только настоящие (trusted) нажатия мыши.
  window.addEventListener(
    'mousedown',
    (e) => {
      if (!e.isTrusted || !ensure() || !cursor || !dot) return;
      const now = Date.now();
      const g = state.glide;
      const glided = !!g && !g.used && Math.hypot(g.x - e.clientX, g.y - e.clientY) <= 2;
      if (g) g.used = true;
      press?.cancel();
      press = dot.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.62)' }], { duration: 110, easing: 'ease-out', fill: 'forwards' });
      const ring = document.createElement('div');
      Object.assign(ring.style, {
        position: 'absolute',
        left: '-18px',
        top: '-18px',
        width: '36px',
        height: '36px',
        boxSizing: 'border-box',
        borderRadius: '50%',
        border: '3px solid #ef3124',
      });
      cursor.append(ring);
      ring
        .animate([{ transform: 'scale(0.5)', opacity: 0.9 }, { transform: 'scale(2.1)', opacity: 0 }], { duration: 520, easing: 'ease-out' })
        .finished.then(
          () => ring.remove(),
          () => ring.remove(),
        );
      void w.__demoPress?.({
        t: now,
        x: e.clientX,
        y: e.clientY,
        cursorX: state.x,
        cursorY: state.y,
        rest: state.arrivedAt ? now - state.arrivedAt : null,
        glided,
        target: e.target instanceof Element ? describe(e.target) : '',
      });
    },
    true,
  );
  window.addEventListener(
    'mouseup',
    (e) => {
      if (!e.isTrusted || !dot) return;
      press?.cancel();
      press = dot.animate([{ transform: 'scale(0.62)' }, { transform: 'scale(1)' }], { duration: 180, easing: 'ease-out' });
    },
    true,
  );
}

/** Точка-курсор, подписи и журнал записи (timeline, presses) для страницы. Вызывать до первого перехода. */
export async function installDirector(page: Page): Promise<Director> {
  const d: Director = { t0: Date.now(), presses: [], timeline: [] };
  directors.set(page, d);
  await page.exposeBinding('__demoPress', (_source, { t, ...press }: RawPress) => {
    d.presses.push({ at: t - d.t0, ...press });
  });
  await page.addInitScript(overlay);
  return d;
}

interface Point {
  x: number;
  y: number;
}
type Box = Point & { width: number; height: number };

const centre = (box: Box): Point => ({ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });
const near = (a: Point, b: Point, px: number) => Math.abs(a.x - b.x) <= px && Math.abs(a.y - b.y) <= px;
const sameBox = (a: Box, b: Box) => near(a, b, 0.5) && Math.abs(a.width - b.width) <= 0.5 && Math.abs(a.height - b.height) <= 0.5;

async function clearCaption(page: Page, wait: boolean): Promise<void> {
  await page.evaluate((w) => {
    const done = (window as DemoWindow).__demo?.clear();
    return w ? done : undefined;
  }, wait);
}

/** Плавная прокрутка к элементу, если его не видно (или его закроет подпись), и ожидание, пока прокрутка встанет. */
async function reveal(target: Locator, inset: number): Promise<void> {
  const scrolling = await target.evaluate((el, i) => (window as DemoWindow).__demo?.reveal(el, i) ?? false, inset);
  if (scrolling) await target.evaluate((el) => (window as DemoWindow).__demo?.still(el, 2500));
}

/** Рамка элемента, когда он на экране и перестал двигаться: две одинаковые рамки с разницей 60 мс. */
async function stableBox(target: Locator): Promise<Box> {
  const page = target.page();
  await target.waitFor({ state: 'visible' });
  await reveal(target, 24);
  await target.scrollIntoViewIfNeeded();
  let prev = await target.boundingBox();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(60);
    const box = await target.boundingBox();
    if (prev && box && sameBox(prev, box)) return box;
    prev = box;
  }
  if (!prev) throw new Error(`Элемент не на экране: ${target}`);
  return prev;
}

/**
 * Куда целиться: центр элемента, когда его не закрывает другой слой. Всплывающее уведомление (справа вверху, до 15 с)
 * может лежать поверх меню профиля — тогда ждём, пока оно уйдёт, а не держим точку на уведомлении.
 */
async function aim(target: Locator): Promise<{ box: Box; point: Point }> {
  const deadline = Date.now() + 16_000;
  for (;;) {
    const box = await stableBox(target);
    const point = centre(box);
    const free = await target
      .evaluate((el, p) => {
        const hit = document.elementFromPoint(p.x, p.y);
        return !!hit && (el.contains(hit) || hit.contains(el));
      }, point)
      .catch(() => true);
    // Не дождались — нажимаем как есть: дальше подождёт сам click().
    if (free || Date.now() > deadline) return { box, point };
    await target.page().waitForTimeout(250);
  }
}

/** Перелёт точки в точку экрана (длительность — по расстоянию), затем туда же настоящая мышь. */
async function glideTo(page: Page, point: Point): Promise<number> {
  const ms = await page.evaluate(({ x, y, pace }) => (window as DemoWindow).__demo!.glide(x, y, pace), { ...point, pace: PACE.glide });
  await page.mouse.move(point.x, point.y);
  return ms;
}

/** Тишина на экране: подпись и курсор не меняются. */
export async function hold(page: Page, ms: number): Promise<void> {
  const d = director(page);
  const start = since(d);
  await page.waitForTimeout(ms);
  d.timeline.push({ kind: 'hold', target: '', glide: 0, start, end: since(d) });
}

/**
 * Нажатие, которое видно: подпись уходит, точка летит к центру элемента, замирает, нажимает (нажал и отпустил — с
 * паузой), затем пауза after — посмотреть, что изменилось.
 */
export async function moveAndClick(target: Locator, { after = PACE.after }: { after?: number } = {}): Promise<void> {
  const page = target.page();
  const d = director(page);
  const start = since(d);
  await clearCaption(page, false);
  let { box, point } = await aim(target);
  let glide = await glideTo(page, point);
  await page.waitForTimeout(PACE.rest);
  // Элемент сдвинулся, пока точка летела (догрузились данные), — догоняем, иначе нажатие пришлось бы мимо точки.
  for (let i = 0; i < 3; i++) {
    const now = await target.boundingBox();
    if (now && near(centre(now), point, 1)) {
      box = now;
      break;
    }
    ({ box, point } = await aim(target));
    glide += await glideTo(page, point);
    await page.waitForTimeout(PACE.rest);
  }
  // position у click() отсчитывается от края внутри рамки элемента — вычитаем рамку (целыми пикселями, как
  // считает сам Playwright), чтобы попасть ровно в point.
  const border = await target.evaluate((el) => {
    const s = getComputedStyle(el);
    return { left: parseInt(s.borderLeftWidth, 10) || 0, top: parseInt(s.borderTopWidth, 10) || 0 };
  });
  await target.click({ position: { x: point.x - box.x - border.left, y: point.y - box.y - border.top }, delay: PACE.press });
  if (after > 0) await page.waitForTimeout(after);
  d.timeline.push({ kind: 'click', target: String(target), glide, start, end: since(d) });
}

/** Подвести точку к элементу без нажатия (мышь тоже наводится — у элемента включается подсветка). */
export async function hoverOn(target: Locator, { hold: ms = 500 }: { hold?: number } = {}): Promise<void> {
  const page = target.page();
  const d = director(page);
  const start = since(d);
  await clearCaption(page, false);
  const glide = await glideTo(page, (await aim(target)).point);
  if (ms > 0) await page.waitForTimeout(ms);
  d.timeline.push({ kind: 'hover', target: String(target), glide, start, end: since(d) });
}

/** Ввод в поле, как у человека: нажать в поле, выделить старое значение и набрать новое по знакам. */
export async function typeInto(target: Locator, text: string): Promise<void> {
  await moveAndClick(target, { after: 200 });
  const page = target.page();
  const d = director(page);
  const start = since(d);
  await target.press('ControlOrMeta+A');
  await target.pressSequentially(text, { delay: PACE.key });
  await page.waitForTimeout(PACE.typed);
  d.timeline.push({ kind: 'type', target: String(target), glide: 0, start, end: since(d) });
}

/** Код подписи — по цифре, чтобы было видно, как он вводится. Фокус уже в поле кода. */
export async function typeCode(page: Page, text: string): Promise<void> {
  const d = director(page);
  const start = since(d);
  await page.keyboard.type(text, { delay: PACE.digit });
  await page.waitForTimeout(PACE.typed);
  d.timeline.push({ kind: 'type', target: 'код подписи', glide: 0, start, end: since(d) });
}

/**
 * Экран успокоился: нет скелетонов загрузки (декоративные — внутри aria-hidden — не в счёт), шрифты загружены,
 * прокрутка стоит. Индикаторы Loader не ждём: у этапов конвейера и пояснения они живут долго.
 */
async function settle(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () =>
        ![...document.querySelectorAll('.mantine-Skeleton-root[data-visible]')].some(
          (el) => el.getClientRects().length > 0 && !el.closest('[aria-hidden="true"]'),
        ),
      undefined,
      { timeout: 15_000, polling: 'raf' },
    )
    .catch(() => undefined);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await (window as DemoWindow).__demo?.still(null, 1500);
  });
}

export interface BeatOptions {
  /** Блок, о котором подпись: плавно прокручивается на экран выше подписи. */
  focus?: Locator;
  /** Добавить к времени на чтение. */
  extra?: number;
  /** Ждать, пока это появится (параллельно с чтением): подпись держится, пока не случится оба. */
  until?: Locator;
  /** Сколько ждать until, мс. */
  timeout?: number;
  /** Действие на экране, пока подпись читают (например, движение слайдера). */
  during?: () => Promise<void>;
}

/**
 * Такт: убрать прошлую подпись, показать блок, дождаться спокойного экрана, показать подпись и держать её
 * dwell(text) + extra; параллельно — ожидание until и действие during.
 */
export async function beat(page: Page, text: string, { focus, extra = 0, until, timeout = 90_000, during }: BeatOptions = {}): Promise<void> {
  const d = director(page);
  const start = since(d);
  await clearCaption(page, true);
  if (focus) {
    await expect(focus).toBeVisible();
    await settle(page);
    await reveal(focus, CAPTION_INSET);
  }
  await settle(page);
  const shown = since(d);
  await page.evaluate((t) => (window as DemoWindow).__demo?.caption(t), text);
  const ms = dwell(text) + extra;
  let untilAt: number | undefined;
  await Promise.all([
    page.waitForTimeout(ms),
    until
      ? expect(until)
          .toBeVisible({ timeout })
          .then(() => {
            untilAt = since(d);
          })
      : undefined,
    during?.(),
  ]);
  d.timeline.push({
    kind: 'beat',
    caption: text,
    chars: text.length,
    dwell: ms,
    start,
    shown,
    end: since(d),
    ...(until ? { until: String(until), untilAt } : {}),
  });
}

/** Способ действий для помощников (pickPersona, apply, sign) в записи демо: каждое нажатие — видимое. */
export const cinema: Actor = {
  click: (target) => moveAndClick(target),
  check: async (target) => {
    await moveAndClick(target);
    await expect(target).toBeChecked();
  },
  fill: (target, value) => typeInto(target, value),
  type: (page, text) => typeCode(page, text),
};

// Slideshow: steps through the playlist, showing each photo for a few seconds
// (videos play to the end), with a fade through black between items.
import { settings, save } from './core.js';
import { h, svg, popover, toggle, numBox, field, toast } from './ui.js';

let player = null;
let timer = null;
export const slideshow = {
  on: false,
  get interval() { return settings.slideInterval || 6; },
  get shuffle() { return !!settings.slideShuffle; }
};

export function initSlideshow(p) { player = p; }

function fade(from, to, ms = 320) {
  return new Promise((resolve) => {
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / ms);
      player.view.setDim(from + (to - from) * k);
      k < 1 ? requestAnimationFrame(step) : resolve();
    };
    requestAnimationFrame(step);
  });
}

function nextIndex() {
  const list = player.state.playlist;
  if (list.length < 2) return -1;
  if (slideshow.shuffle) {
    let i;
    do { i = Math.floor(Math.random() * list.length); } while (i === player.state.index);
    return i;
  }
  return (player.state.index + 1) % list.length;
}

export async function advance(dir = 1) {
  clearTimeout(timer);
  const list = player.state.playlist;
  if (!list.length) return;
  const i = dir > 0 ? nextIndex() : (player.state.index - 1 + list.length) % list.length;
  if (i < 0) { schedule(); return; }
  await fade(0, 1);
  await player.load(i);
  await fade(1, 0);
}

// Called whenever an item finishes loading
export function onShown(item) {
  if (slideshow.on && item.info.isImage) schedule();
}
function schedule() {
  clearTimeout(timer);
  if (slideshow.on && player.current()?.info.isImage) timer = setTimeout(() => advance(1), slideshow.interval * 1000);
}

export function start() {
  if (!player.state.playlist.length) return toast('Open some photos or videos first.', 'err');
  slideshow.on = true;
  document.body.classList.add('slideshow');
  toast(`Slideshow: ${slideshow.interval} s per photo`, 'ok');
  schedule();
}
export function stop() {
  slideshow.on = false;
  clearTimeout(timer);
  document.body.classList.remove('slideshow');
  player.view.setDim(0);
}

export function openSlideshowMenu(anchor) {
  popover(anchor, () => [
    h('div', { class: 'menu-title' }, 'Slideshow'),
    h('button', { class: 'menu-item', onclick: () => { slideshow.on ? stop() : start(); anchor.classList.toggle('on', slideshow.on); } },
      h('span', { html: svg(slideshow.on ? 'pause' : 'play') }), slideshow.on ? 'Stop slideshow' : 'Start slideshow'),
    h('div', { class: 'menu-grid' },
      h('span', {}, 'Each photo for'), numBox({ value: slideshow.interval, min: 2, max: 60, step: 1, unit: 's', width: 80, onChange: (v) => { save({ slideInterval: v }); schedule(); } }),
      h('span', {}, 'Shuffle'), toggle(slideshow.shuffle, (v) => save({ slideShuffle: v }))),
    h('div', { class: 'muted', style: { padding: '4px 8px', fontSize: '12px', maxWidth: '260px' } }, 'Videos in the playlist play to the end before moving on. Background music is in the CC menu.')
  ]);
}

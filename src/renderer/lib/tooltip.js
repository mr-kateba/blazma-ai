// Tooltips in the app's style, shown quickly, for every element with a
// title attribute (also ones added later). The native tooltip is slow and
// looks like Windows, so the title is set aside while the pointer is over
// the element and put back when it leaves (code and tests can still read it).

const DELAY_MS = 250;
const GAP = 8;

let tip = null;
let current = null; // { node, title }
let timer = null;
let watch = null; // hides the tooltip if its element is replaced (e.g. re-render)

function tipNode() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

function place(node) {
  const t = tipNode();
  const r = node.getBoundingClientRect();
  t.style.left = '0px';
  t.style.top = '0px';
  t.hidden = false;
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  let top = r.bottom + GAP;
  if (top + h > window.innerHeight - 4) top = r.top - GAP - h; // no room below: above
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
  t.style.left = `${Math.round(left)}px`;
  t.style.top = `${Math.round(Math.max(4, top))}px`;
}

function hide() {
  clearTimeout(timer);
  clearInterval(watch);
  timer = null;
  watch = null;
  if (tip) tip.hidden = true;
  if (current) {
    // Put the title back unless the code changed it meanwhile.
    if (!current.node.hasAttribute('title')) current.node.setAttribute('title', current.title);
    current = null;
  }
}

function show(node) {
  if (current && current.node === node) return;
  hide();
  const title = node.getAttribute('title');
  if (!title || !title.trim()) return;
  current = { node, title };
  node.removeAttribute('title');
  if (!node.hasAttribute('aria-label') && !node.textContent.trim()) node.setAttribute('aria-label', title);
  timer = setTimeout(() => {
    if (!current || current.node !== node || !node.isConnected) return;
    const t = tipNode();
    t.textContent = title;
    t.dir = 'auto';
    place(node);
    watch = setInterval(() => {
      if (current && !current.node.isConnected) hide();
    }, 300);
  }, DELAY_MS);
}

export function initTooltips() {
  document.addEventListener('mouseover', (e) => {
    // Inside the element already shown (an icon in a button): keep it.
    if (current && current.node.contains(e.target)) return;
    const node = e.target.closest && e.target.closest('[title]');
    if (node) show(node);
    else hide();
  });
  document.addEventListener('mouseout', (e) => {
    if (current && (!e.relatedTarget || !current.node.contains(e.relatedTarget))) hide();
  });
  // Keyboard users see it too.
  document.addEventListener('focusin', (e) => {
    const node = e.target.closest && e.target.closest('[title]');
    if (node && node.matches(':focus-visible')) show(node);
  });
  document.addEventListener('focusout', hide);
  for (const ev of ['mousedown', 'keydown', 'wheel']) document.addEventListener(ev, hide, true);
  window.addEventListener('blur', hide);
}

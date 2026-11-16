// Injected via chrome.scripting.executeScript({ func }); must stay self-contained.
export function agentOverlay(cmd, a = {}) {
  const ID = 'edge-bridge-overlay';
  let host = document.getElementById(ID);
  let st = window.__ebOverlay;

  if (cmd === 'hide' || cmd === 'unhide') {
    if (!host) return true;
    host.style.visibility = cmd === 'hide' ? 'hidden' : '';
    if (cmd === 'unhide') return true;
    // The screenshot is taken from the last composited frame, so wait until the hidden state is painted.
    return new Promise((resolve) => {
      const done = () => resolve(true);
      setTimeout(done, 150);
      requestAnimationFrame(() => requestAnimationFrame(done));
    });
  }

  if (!host || !st || st.host !== host) {
    host?.remove();
    host = document.createElement('div');
    host.id = ID;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { --c: 14, 99, 156; }
        .wrap { position: fixed; inset: 0; opacity: 0; transition: opacity .25s ease; font: 500 13px/1.3 system-ui, -apple-system, sans-serif; }
        .wrap.on { opacity: 1; }
        .glow { position: fixed; inset: 0; box-shadow: inset 0 0 0 3px rgba(var(--c), .85), inset 0 0 28px rgba(var(--c), .35); }
        .cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; opacity: 0;
          transition: transform .28s cubic-bezier(.2, .8, .2, 1), opacity .2s ease; filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
        .cursor.vis { opacity: 1; }
        .ripple { position: fixed; left: 0; top: 0; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%;
          border: 2px solid rgba(var(--c), .9); opacity: 0; transform: scale(.3); }
        .ripple.go { animation: rip .45s ease-out; }
        @keyframes rip { from { opacity: .9; transform: scale(.3); } to { opacity: 0; transform: scale(1.6); } }
        .pill { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); max-width: min(560px, calc(100vw - 32px));
          display: flex; align-items: center; gap: 8px; padding: 7px 14px; border-radius: 999px;
          background: rgba(20, 24, 31, .92); color: #fff; box-shadow: 0 4px 18px rgba(0,0,0,.25); white-space: nowrap; overflow: hidden; }
        .pill .txt { overflow: hidden; text-overflow: ellipsis; }
        .pill b { font-weight: 650; color: rgb(120, 190, 240); }
        .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: rgb(var(--c)); box-shadow: 0 0 0 0 rgba(var(--c), .7); animation: pulse 1.4s infinite; }
        @keyframes pulse { 70% { box-shadow: 0 0 0 7px rgba(var(--c), 0); } 100% { box-shadow: 0 0 0 0 rgba(var(--c), 0); } }
        @media (prefers-reduced-motion: reduce) { .cursor, .wrap { transition: none; } .dot, .ripple.go { animation: none; } }
      </style>
      <div class="wrap">
        <div class="glow"></div>
        <svg class="cursor" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.4 19.1 L10.3 12.6 L16.5 12.6 Z" fill="rgb(14,99,156)" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>
        <div class="ripple"></div>
        <div class="pill"><span class="dot"></span><span class="txt"></span></div>
      </div>`;
    document.documentElement.appendChild(host);
    st = window.__ebOverlay = { host, root, timer: 0 };
  }

  const { root } = st;
  const wrap = root.querySelector('.wrap');
  const cursor = root.querySelector('.cursor');
  const ripple = root.querySelector('.ripple');
  const txt = root.querySelector('.txt');

  txt.replaceChildren();
  const b = document.createElement('b');
  b.textContent = 'Agent';
  txt.append(b, ` · ${a.label || 'arbeitet'}`);
  wrap.classList.add('on');

  if (typeof a.x === 'number' && typeof a.y === 'number') {
    cursor.style.transform = `translate(${a.x - 3}px, ${a.y - 2}px)`;
    cursor.classList.add('vis');
    if (a.click) {
      setTimeout(() => {
        ripple.style.left = `${a.x}px`;
        ripple.style.top = `${a.y}px`;
        ripple.classList.remove('go');
        void ripple.offsetWidth;
        ripple.classList.add('go');
      }, 280);
    }
  }

  clearTimeout(st.timer);
  st.timer = setTimeout(() => {
    wrap.classList.remove('on');
    cursor.classList.remove('vis');
  }, a.holdMs || 3500);
  return true;
}

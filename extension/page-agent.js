// Injected via chrome.scripting.executeScript({ func }), which serialises only this
// function's source: everything it needs must live inside it, no outer references.
export function pageAgent(cmd, a) {
  const ATTR = 'data-eb-ref';
  const clip = (s, n) => {
    s = String(s ?? '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const q = (s) => JSON.stringify(s);

  function* roots(root) {
    yield root;
    for (const n of root.querySelectorAll('*')) {
      if (n.shadowRoot) yield* roots(n.shadowRoot);
      if (n.tagName === 'IFRAME') {
        let d = null;
        try {
          d = n.contentDocument;
        } catch {}
        if (d) yield* roots(d);
      }
    }
  }

  function findEl() {
    const sel = a.ref ? `[${ATTR}="${a.ref}"]` : a.selector;
    if (!sel) throw new Error('ref oder selector angeben');
    for (const r of roots(document)) {
      const hit = r.querySelector(sel);
      if (hit) return hit;
    }
    throw new Error(
      a.ref ? `Element ${a.ref} nicht gefunden. Die Seite hat sich geändert, bitte neuen snapshot holen.` : `Kein Element für Selektor ${a.selector}`,
    );
  }

  function frameOffset(el) {
    let x = 0;
    let y = 0;
    let win = el.ownerDocument.defaultView;
    while (win && win !== window && win.frameElement) {
      const fe = win.frameElement;
      const r = fe.getBoundingClientRect();
      x += r.left + fe.clientLeft;
      y += r.top + fe.clientTop;
      win = fe.ownerDocument.defaultView;
    }
    return { x, y };
  }

  function deepHit(doc, x, y) {
    let el = doc.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function contains(outer, inner) {
    for (let n = inner; n; n = n.parentNode || n.host) if (n === outer) return true;
    return false;
  }

  function roleOf(el) {
    const r = el.getAttribute('role');
    if (r) return r.split(/\s+/)[0];
    const t = el.tagName.toLowerCase();
    if (t === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(ty)) return 'button';
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'range') return 'slider';
      if (ty === 'number') return 'spinbutton';
      if (ty === 'search') return 'searchbox';
      if (ty === 'file') return 'file-upload';
      if (ty === 'hidden') return null;
      return 'textbox';
    }
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'img') return 'img';
    if (t === 'iframe') return 'iframe';
    if (t === 'dialog') return 'dialog';
    if (t === 'nav') return 'navigation';
    if (t === 'main') return 'main';
    if (t === 'form') return 'form';
    if (t === 'table') return 'table';
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    return null;
  }

  const INTERACTIVE = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'treeitem', 'file-upload',
  ]);
  const CONTAINERS = new Set(['navigation', 'main', 'form', 'dialog', 'table', 'alertdialog', 'alert', 'menu', 'tablist', 'banner', 'search']);

  function nameOf(el) {
    const al = el.getAttribute('aria-label');
    if (al?.trim()) return al;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent || '').join(' ');
      if (t.trim()) return t;
    }
    const tag = el.tagName;
    if (tag === 'IMG') return el.alt || el.title || '';
    if (el.labels?.length) {
      const t = [...el.labels].map((l) => l.innerText).join(' ');
      if (t.trim()) return t;
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (['submit', 'button', 'reset'].includes(el.type)) return el.value;
      return el.placeholder || el.title || el.getAttribute('aria-placeholder') || el.name || '';
    }
    if (el.isContentEditable) return el.getAttribute('aria-placeholder') || el.dataset.placeholder || el.title || '';
    const txt = el.innerText || el.textContent || '';
    if (txt.trim()) return txt;
    const img = el.querySelector('img[alt]');
    if (img?.alt) return img.alt;
    const svgTitle = el.querySelector('svg title');
    if (svgTitle?.textContent) return svgTitle.textContent;
    return el.title || '';
  }

  function visible(el) {
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function describe(el, role) {
    return `${role} ${q(clip(nameOf(el), 80))}`;
  }

  if (cmd === 'snapshot') {
    const lines = [];
    let size = 0;
    let truncated = false;
    let next = window.__ebNext || 1;
    const seen = new Set();
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'PATH']);

    const pushRaw = (depth, line) => {
      if (truncated) return;
      const s = '  '.repeat(depth) + '- ' + line;
      if (size + s.length > a.maxChars) {
        truncated = true;
        return;
      }
      lines.push(s);
      size += s.length + 1;
    };

    let buf = '';
    let bufDepth = 0;
    const flush = () => {
      const t = buf.replace(/\s+/g, ' ').trim();
      buf = '';
      if (t) pushRaw(bufDepth, `text: ${clip(t, 400)}`);
    };
    const addText = (depth, t) => {
      if (!buf.trim()) bufDepth = depth;
      buf += t;
    };
    const push = (depth, line) => {
      flush();
      pushRaw(depth, line);
    };

    const refFor = (el) => {
      let r = el.getAttribute(ATTR);
      if (!r || seen.has(r)) {
        r = 'e' + next++;
        el.setAttribute(ATTR, r);
      }
      seen.add(r);
      return r;
    };

    const walkNodes = (nodes, depth, parentPointer, inInteractive, textOk) => {
      for (const n of nodes) {
        if (n.nodeType === 3) {
          if (textOk && !inInteractive) addText(depth, n.nodeValue);
        } else if (n.nodeType === 1) {
          if (n.tagName === 'SLOT') {
            const assigned = n.assignedNodes({ flatten: true });
            walkNodes(assigned.length ? assigned : n.childNodes, depth, parentPointer, inInteractive, textOk);
          } else walk(n, depth, parentPointer, inInteractive);
        }
      }
    };

    const walkChildren = (parent, depth, parentPointer, inInteractive, textOk = true) => {
      walkNodes((parent.shadowRoot || parent).childNodes, depth, parentPointer, inInteractive, textOk);
    };

    const walk = (el, depth, parentPointer, inInteractive) => {
      if (truncated || SKIP.has(el.tagName)) return;
      if (el.tagName === 'INPUT' && el.type === 'file' && !visible(el)) {
        push(depth, `file-upload ${q(clip(nameOf(el), 60))} [ref=${refFor(el)}] [unsichtbar, upload_file trotzdem möglich]`);
        return;
      }
      if (el.getAttribute('aria-hidden') === 'true') return;
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      if (style.display === 'none') return;
      if (style.display === 'contents') return walkChildren(el, depth, parentPointer, inInteractive);
      const pointer = style.cursor === 'pointer';
      let role = roleOf(el);
      const focusable = el.hasAttribute('tabindex') && el.tabIndex >= 0;
      let interactive = INTERACTIVE.has(role) || (!role && (focusable || el.hasAttribute('onclick') || (pointer && !parentPointer)));
      if (interactive && !role) role = 'clickable';
      const isVisible = visible(el);
      let childDepth = depth;

      if (isVisible && interactive) {
        const tag = el.tagName;
        let line = `${role} ${q(clip(nameOf(el), 100))} [ref=${refFor(el)}]`;
        if (role === 'link') {
          const href = el.getAttribute('href') || '';
          if (href && !href.startsWith('javascript:')) line += ` → ${clip(href, 80)}`;
        }
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          if (role === 'checkbox' || role === 'radio') line += el.checked ? ' [checked]' : ' [unchecked]';
          else if (el.type === 'password') line += el.value ? ' value="••••"' : '';
          else if (el.value) line += ` value=${q(clip(el.value, 100))}`;
          if (el.type && !['text', 'checkbox', 'radio', 'submit', 'button', 'textarea'].includes(el.type)) line += ` type=${el.type}`;
        } else if (el.isContentEditable && el.innerText.trim()) {
          line += ` value=${q(clip(el.innerText, 150))}`;
        }
        if (tag === 'SELECT') {
          const sel = [...el.selectedOptions].map((o) => o.text).join(', ');
          line += ` selected=${q(clip(sel, 60))}`;
        }
        for (const st of ['checked', 'expanded', 'selected', 'pressed']) {
          const v = el.getAttribute('aria-' + st);
          if (v != null && tag !== 'INPUT') line += ` [${st}=${v}]`;
        }
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' [disabled]';
        push(depth, line);
        if (tag === 'SELECT') {
          [...el.options].slice(0, 30).forEach((o) => push(depth + 1, `option ${q(clip(o.text, 60))}${o.selected ? ' [selected]' : ''}`));
          if (el.options.length > 30) push(depth + 1, `… ${el.options.length - 30} weitere Optionen`);
          return;
        }
        if (tag === 'INPUT' || tag === 'TEXTAREA' || role === 'textbox') return;
        childDepth = depth + 1;
        inInteractive = true;
      } else if (isVisible && role === 'heading') {
        const level = el.getAttribute('aria-level') || el.tagName.slice(1);
        push(depth, `heading ${q(clip(el.innerText, 150))} [level=${level}]`);
        return;
      } else if (isVisible && role === 'img' && !inInteractive) {
        const n = clip(nameOf(el), 100);
        if (n) push(depth, `img ${q(n)}`);
        return;
      } else if (role === 'iframe') {
        let doc = null;
        try {
          doc = el.contentDocument;
        } catch {}
        if (doc?.body) {
          push(depth, `iframe ${q(clip(el.getAttribute('title') || el.src, 80))}`);
          walk(doc.body, depth + 1, false, inInteractive);
        } else if (isVisible) {
          push(depth, `iframe ${q(clip(el.src, 80))} [fremde Herkunft, Inhalt nicht lesbar – Klicks per x/y aus screenshot]`);
        }
        return;
      } else if (isVisible && CONTAINERS.has(role)) {
        const n = el.getAttribute('aria-label');
        push(depth, `${role}${n ? ' ' + q(clip(n, 60)) : ''}:`);
        childDepth = depth + 1;
      }

      const block = !style.display.startsWith('inline');
      if (block) flush();
      walkChildren(el, childDepth, pointer, inInteractive, isVisible);
      if (block) flush();
    };

    walk(document.body || document.documentElement, 0, false, false);
    flush();
    window.__ebNext = next;
    const head = [
      `URL: ${location.href}`,
      `Titel: ${document.title}`,
      `Scroll: ${Math.round(scrollY)} von ${Math.max(0, document.documentElement.scrollHeight - innerHeight)} px`,
      '',
    ];
    if (truncated) lines.push(`… gekürzt bei ${a.maxChars} Zeichen. Für mehr: maxChars erhöhen, scrollen oder get_text.`);
    return head.join('\n') + lines.join('\n');
  }

  try {
    if (cmd === 'locate' || cmd === 'rect') {
      const el = findEl();
      if (!a.noScroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const off = frameOffset(el);
      if (cmd === 'rect') {
        return { x: r.left + off.x + scrollX, y: r.top + off.y + scrollY, width: Math.max(1, r.width), height: Math.max(1, r.height) };
      }
      if (r.width === 0 && r.height === 0) throw new Error('Element ist nicht sichtbar (Größe 0). Evtl. erst Menü öffnen oder scrollen.');
      const lx = r.left + Math.min(r.width / 2, Math.max(1, r.width - 1));
      const ly = r.top + Math.min(r.height / 2, Math.max(1, r.height - 1));
      const hit = deepHit(el.ownerDocument, lx, ly);
      let covered = null;
      if (hit && !contains(el, hit) && !contains(hit, el)) covered = `${hit.tagName.toLowerCase()} ${q(clip(hit.innerText || hit.getAttribute('aria-label') || '', 40))}`;
      return { x: lx + off.x, y: ly + off.y, label: describe(el, roleOf(el) || el.tagName.toLowerCase()), name: clip(nameOf(el), 60), covered };
    }

    if (cmd === 'prepareType') {
      let el = document.activeElement;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      while (el?.tagName === 'IFRAME') {
        try {
          el = el.contentDocument.activeElement;
        } catch {
          break;
        }
      }
      const kind = el?.isContentEditable ? 'contenteditable' : el?.tagName === 'TEXTAREA' ? 'textarea' : el?.tagName === 'INPUT' ? 'input' : 'other';
      if (a.clear) {
        if (kind === 'input' || kind === 'textarea') el.select();
        else if (kind === 'contenteditable') {
          const range = el.ownerDocument.createRange();
          range.selectNodeContents(el);
          const sel = el.ownerDocument.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      return { kind };
    }

    if (cmd === 'focusedValue') {
      let el = document.activeElement;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      if (!el) return null;
      if (el.type === 'password') return '••••';
      if ('value' in el && typeof el.value === 'string') return clip(el.value, 300);
      if (el.isContentEditable) return clip(el.innerText, 300);
      return null;
    }

    if (cmd === 'selectOption') {
      const el = findEl();
      if (el.tagName !== 'SELECT') throw new Error('Element ist kein <select>. Für eigene Dropdowns: click auf das Feld, dann auf die Option.');
      const want = String(a.value);
      const opt = [...el.options].find((o) => o.value === want) || [...el.options].find((o) => o.text.trim() === want.trim()) ||
        [...el.options].find((o) => o.text.toLowerCase().includes(want.toLowerCase()));
      if (!opt) throw new Error(`Option "${want}" nicht gefunden. Verfügbar: ${[...el.options].map((o) => o.text).slice(0, 30).join(' | ')}`);
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: opt.text, value: opt.value };
    }

    if (cmd === 'viewport') {
      return {
        x: Math.round(innerWidth / 2),
        y: Math.round(innerHeight / 2),
        scrollY: Math.round(scrollY),
        maxScrollY: Math.max(0, document.documentElement.scrollHeight - innerHeight),
      };
    }

    if (cmd === 'text') {
      const t = document.body?.innerText || '';
      return { url: location.href, title: document.title, text: t.length > a.maxChars ? t.slice(0, a.maxChars) + '\n… (gekürzt)' : t, totalChars: t.length };
    }

    if (cmd === 'check') {
      if (a.selector) {
        for (const r of roots(document)) if (r.querySelector(a.selector)) return true;
        return false;
      }
      for (const r of roots(document)) {
        const t = r.body ? r.body.innerText : r.textContent;
        if (t?.includes(a.text)) return true;
      }
      return false;
    }
  } catch (err) {
    return { __error: err.message };
  }
  return { __error: `unknown page command ${cmd}` };
}

// Propio SAE · conector de la app con Supabase.
// La app de producción se escribió para claude.ai y pide sus servicios con window.claude.use('db' | 'user' | 'assets' | 'sample').
// Este archivo ofrece esos mismos servicios con Supabase, así la app corre en cualquier teléfono sin cuenta de Claude:
//   db     → tabla "docs" (una fila por documento), con cambios en vivo
//   user   → usuario + PIN (Supabase Auth) y rol desde la tabla "perfiles"
//   assets → fotos en el bucket privado "fotos"
//   sample → lectura de fotos con la función "leer-foto" (API de Claude de la empresa, en el servidor)
(function () {
  'use strict';
  const CFG = window.PROPIO_CONFIG || {};
  if (!window.supabase || !CFG.supabaseUrl) { console.error('Falta supabase-js o config.js'); return; }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'propio-sae-sesion' } });
  window.propioSB = sb;
  const DOM = CFG.dominioUsuarios || 'propio-sae.app';
  const SOLO_LECTURA = ['consulta', 'direccion'];
  const clonar = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const hex32 = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  const err = (code, message) => Object.assign(new Error(message || code), { code });
  function mapear(e) {
    if (!e) return err('unknown');
    if (e.code === '42501' || /row-level security|permission denied/i.test(e.message || '')) return err('not_granted', 'Sin permiso para guardar esto');
    if (e.code === 'P0002' || /no_existe/.test(e.message || '')) return err('not_found', 'No existe');
    if (/fetch|network|Failed to fetch|timeout/i.test(e.message || '')) return err('unavailable', 'Sin conexión');
    return err(e.code || 'unknown', e.message);
  }

  // ---------- Ingreso con usuario y PIN ----------
  let perfil = null, sesionLista;
  const correoDe = u => u.trim().toLowerCase().replace(/\s+/g, '') + '@' + DOM;
  function pantallaIngreso(msg) {
    return new Promise(resolve => {
      let caja = document.getElementById('propio-ingreso');
      if (!caja) {
        caja = document.createElement('div'); caja.id = 'propio-ingreso';
        caja.innerHTML = `<style>
          #propio-ingreso{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:var(--bg,#eceeec);padding:max(16px,env(safe-area-inset-left,0px));font:16px "IBM Plex Sans",system-ui,sans-serif;color:var(--ink,#1a1e1c)}
          #propio-ingreso form{width:min(360px,100%);background:var(--surface,#fbfcfb);border:1px solid var(--line,#cdd2ce);border-radius:16px;padding:22px;display:flex;flex-direction:column;gap:12px}
          #propio-ingreso h2{margin:0;font:700 26px "Barlow Condensed","Arial Narrow",sans-serif;color:var(--accent,#14766b)}
          #propio-ingreso label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted,#58615c)}
          #propio-ingreso input{font:18px system-ui,sans-serif;padding:11px;border-radius:10px;border:1px solid var(--line,#cdd2ce);background:var(--surface,#fff);color:inherit;min-height:46px}
          #propio-ingreso button{font:600 16px system-ui,sans-serif;min-height:48px;border-radius:10px;border:0;background:var(--accent,#14766b);color:var(--accent-ink,#fff);cursor:pointer}
          #propio-ingreso .msg{font-size:14px;color:var(--bad,#c2402f);min-height:1.2em;margin:0}
          #propio-ingreso small{color:var(--muted,#58615c);font-size:12px}</style>
          <form autocomplete="on"><h2>Propio SAE · Producción</h2>
          <label>Usuario<input id="pi-usuario" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
          <label>PIN<input id="pi-pin" name="password" type="password" inputmode="numeric" autocomplete="current-password" required minlength="6"></label>
          <p class="msg" id="pi-msg"></p><button type="submit" id="pi-ok">Entrar</button>
          <small>Si olvidaste el PIN, pedile al gerente que te asigne uno nuevo.</small></form>`;
        document.body.appendChild(caja);
      }
      caja.hidden = false;
      const m = caja.querySelector('#pi-msg'); m.textContent = msg || '';
      const f = caja.querySelector('form');
      f.onsubmit = async e => {
        e.preventDefault();
        const b = caja.querySelector('#pi-ok'); b.disabled = true; b.textContent = 'Entrando…'; m.textContent = '';
        const { error } = await sb.auth.signInWithPassword({ email: correoDe(caja.querySelector('#pi-usuario').value), password: caja.querySelector('#pi-pin').value });
        b.disabled = false; b.textContent = 'Entrar';
        if (error) { m.textContent = /invalid/i.test(error.message) ? 'Usuario o PIN incorrecto.' : 'No se pudo entrar: ' + error.message; return; }
        caja.hidden = true; resolve();
      };
    });
  }
  async function cargarPerfil() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    const { data } = await sb.from('perfiles').select('*').eq('user_id', user.id).maybeSingle();
    return data;
  }
  sesionLista = (async () => {
    // Esperar a que exista el body (este archivo se carga en el <head>)
    if (!document.body) await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
    for (;;) {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { await pantallaIngreso(); continue; }
      perfil = await cargarPerfil();
      if (perfil && perfil.activo) break;
      await sb.auth.signOut();
      await pantallaIngreso(perfil ? 'Tu usuario está desactivado. Hablá con el gerente.' : 'Tu usuario no tiene perfil en la planta. Hablá con el gerente.');
    }
    barraUsuario();
    return perfil;
  })();
  function barraUsuario() {
    const poner = () => {
      const c = document.querySelector('header .controles'); if (!c || document.getElementById('propio-salir')) return;
      const b = document.createElement('button'); b.className = 'btn'; b.type = 'button'; b.id = 'propio-salir';
      b.textContent = '⎋ ' + (perfil.nombre || perfil.usuario); b.title = 'Salir de la app';
      b.onclick = async () => { if (b.dataset.conf) { await sb.auth.signOut(); location.reload(); } else { b.dataset.conf = '1'; b.textContent = 'Tocá otra vez para salir'; setTimeout(() => { delete b.dataset.conf; b.textContent = '⎋ ' + (perfil.nombre || perfil.usuario); }, 4000); } };
      c.appendChild(b);
      if (perfil.rol === 'gerente') { const u = document.createElement('button'); u.className = 'btn'; u.type = 'button'; u.id = 'propio-usuarios'; u.textContent = '🔑 Usuarios y PIN'; u.onclick = panelUsuarios; c.appendChild(u); }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', poner); else poner();
  }

  // ---------- db: colecciones con cambios en vivo ----------
  const COLS = new Map();   // coleccion → { filas: Map(id → {datos, version}), oyentes: Set, cargado: Promise }
  function col(c) {
    let st = COLS.get(c); if (st) return st;
    st = { filas: new Map(), oyentes: new Set() };
    COLS.set(c, st);
    const avisar = () => st.oyentes.forEach(f => { try { f(); } catch (e) { console.error(e); } });
    st.avisar = avisar;
    st.cargado = (async () => {
      await sesionLista;
      for (let desde = 0; ; desde += 1000) {
        const { data, error } = await sb.from('docs').select('id,datos,version').eq('coleccion', c).range(desde, desde + 999);
        if (error) throw mapear(error);
        for (const r of data) st.filas.set(r.id, { datos: r.datos, version: r.version });
        if (data.length < 1000) break;
      }
      sb.channel('docs:' + c).on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'coleccion=eq.' + c }, p => {
        if (p.eventType === 'DELETE') st.filas.delete(p.old.id);
        else st.filas.set(p.new.id, { datos: p.new.datos, version: p.new.version });
        avisar();
      }).subscribe();
    })();
    return st;
  }
  const campo = (o, f) => f.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  const OPS = { '==': (a, b) => a === b, '!=': (a, b) => a !== b, '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, 'in': (a, b) => Array.isArray(b) && b.includes(a), 'array-contains': (a, b) => Array.isArray(a) && a.includes(b) };
  const META = { fromCache: false, hasPendingWrites: false };
const docSnap = (id, f) => ({ id, exists: !!f, data: () => (f ? clonar(f.datos) : undefined), version: f ? f.version : undefined, metadata: META });
  function separar(ruta) { const i = ruta.lastIndexOf('/'); return [ruta.slice(0, i), ruta.slice(i + 1)]; }

  class Consulta {
    constructor(c, filtros = [], orden = null, lim = null) { this.c = c; this.filtros = filtros; this.orden = orden; this.lim = lim; }
    where(f, op, v) { return new Consulta(this.c, [...this.filtros, [f, op, v]], this.orden, this.lim); }
    orderBy(f, dir = 'asc') { return new Consulta(this.c, this.filtros, [f, dir], this.lim); }
    limit(n) { return new Consulta(this.c, this.filtros, this.orden, n); }
    doc(id) { return new Ref(this.c + '/' + id); }
    async add(datos) { const r = new Ref(this.c + '/' + hex32().slice(0, 20)); await r.set(datos); return r; }
    _snap(st) {
      let docs = [...st.filas].filter(([, f]) => this.filtros.every(([k, op, v]) => (OPS[op] || OPS['=='])(campo(f.datos, k), v))).map(([id, f]) => docSnap(id, f));
      if (this.orden) { const [k, d] = this.orden, s = d === 'desc' ? -1 : 1; docs.sort((a, b) => { const x = campo(a.data(), k), y = campo(b.data(), k); return x === y ? 0 : (x > y ? s : -s); }); }
      if (this.lim != null) docs = docs.slice(0, this.lim);
      return { docs, size: docs.length, empty: !docs.length, forEach: fn => docs.forEach(fn), metadata: META };
    }
    onSnapshot(cb, onErr) {
      const st = col(this.c), emitir = () => cb(this._snap(st));
      st.cargado.then(() => { st.oyentes.add(emitir); emitir(); }, e => onErr && onErr(e));
      return () => st.oyentes.delete(emitir);
    }
    async get() { const st = col(this.c); await st.cargado; return this._snap(st); }
  }
  class Ref {
    constructor(ruta) { this.ruta = ruta; [this.c, this.id] = separar(ruta); }
    collection(sub) { return new Consulta(this.ruta + '/' + sub); }
    async get() {
      await sesionLista;
      const { data, error } = await sb.from('docs').select('datos,version').eq('coleccion', this.c).eq('id', this.id).maybeSingle();
      if (error) throw mapear(error);
      return docSnap(this.id, data);
    }
    async set(datos) {
      await sesionLista;
      if (SOLO_LECTURA.includes(perfil.rol)) throw err('not_granted', 'Solo lectura');
      const { data, error } = await sb.from('docs').upsert({ coleccion: this.c, id: this.id, ruta: this.ruta, datos: clonar(datos) }, { onConflict: 'ruta' }).select('version').single();
      if (error) throw mapear(error);
      const st = COLS.get(this.c); if (st) { st.filas.set(this.id, { datos: clonar(datos), version: data.version }); st.avisar(); }
    }
    async update(parche) {
      await sesionLista;
      const { data, error } = await sb.rpc('doc_actualizar', { p_coleccion: this.c, p_id: this.id, p_parche: clonar(parche) });
      if (error) throw mapear(error);
      return data;
    }
    onSnapshot(cb, onErr) {
      const st = col(this.c), emitir = () => cb(docSnap(this.id, st.filas.get(this.id)));
      st.cargado.then(() => { st.oyentes.add(emitir); emitir(); }, e => onErr && onErr(e));
      return () => st.oyentes.delete(emitir);
    }
  }
  const db = { collection: c => new Consulta(c), doc: ruta => new Ref(ruta) };

  // ---------- user ----------
  let nombresCache = null;
  async function nombres() {
    if (nombresCache) return nombresCache;
    const { data } = await sb.from('perfiles').select('user_id,nombre,usuario,ids_previos');
    const m = {};
    for (const p of data || []) { const n = { name: p.nombre || p.usuario }; m[p.user_id] = n; for (const v of p.ids_previos || []) m[v] = n; }
    nombresCache = m; setTimeout(() => { nombresCache = null; }, 5 * 60 * 1000);
    return m;
  }
  const user = {
    id: async () => (await sesionLista).user_id,
    me: async () => { const p = await sesionLista; return { id: p.user_id, name: p.nombre }; },
    isOwner: async () => (await sesionLista).rol === 'gerente',
    canEdit: async () => (await sesionLista).rol === 'gerente',
    can: async () => !SOLO_LECTURA.includes((await sesionLista).rol),
    rol: async () => (await sesionLista).rol,
    profiles: async ids => { const m = await nombres(); const r = {}; for (const id of ids || []) r[id] = m[id] || { name: '' }; return r; },
  };

  // ---------- assets: fotos en el bucket privado ----------
  const assets = {
    upload: async (blob, opts = {}) => {
      await sesionLista;
      const id = hex32(), type = opts.type || blob.type || 'image/jpeg';
      const { error } = await sb.storage.from('fotos').upload(id, blob, { contentType: type, upsert: false });
      if (error) throw err(/size|large/i.test(error.message) ? 'too_large' : 'upload_failed', error.message);
      return { id, url: '#pf-' + id, sizeBytes: blob.size, contentType: type };
    },
  };
  // Las fotos se muestran con enlaces firmados (privados, vencen en 1 hora). La app pone "#pf-<id>" y acá se reemplaza.
  window.propioFotoUrl = id => '#pf-' + id;
  const firmadas = new Map();
  async function firmar(id) {
    const c = firmadas.get(id); if (c && c.vence > Date.now()) return c.url;
    const { data, error } = await sb.storage.from('fotos').createSignedUrl(id, 3600);
    if (error || !data) return null;
    firmadas.set(id, { url: data.signedUrl, vence: Date.now() + 55 * 60 * 1000 });
    return data.signedUrl;
  }
  const SEL_FOTO = 'img[src^="#pf-"],a[href^="#pf-"]';
  function revisarFotos(raiz) {
    const base = raiz.querySelectorAll ? raiz : document;
    [...(base.matches && base.matches(SEL_FOTO) ? [base] : []), ...base.querySelectorAll(SEL_FOTO)].forEach(async el => {
      const attr = el.tagName === 'IMG' ? 'src' : 'href', id = el.getAttribute(attr).slice(4);
      el.setAttribute(attr, el.tagName === 'IMG' ? 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==' : '#');
      el.dataset.pf = id;
      const u = await firmar(id); if (u) el.setAttribute(attr, u);
    });
  }
  new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) revisarFotos(n); if (ms.some(m => m.type === 'attributes')) revisarFotos(document); })
    .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href'] });

  // ---------- sample: lectura de fotos en el servidor ----------
  const aBase64 = b => new Promise((ok, mal) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = mal; r.readAsDataURL(b); });
  const sample = Object.assign(async () => { throw err('not_supported', 'Solo lectura de fotos con sample.json'); }, {
    limits: async () => ({ images: { maxCount: 4 } }),
    json: async (prompt, opts = {}) => {
      await sesionLista;
      const imagenes = await Promise.all((opts.images || []).slice(0, 4).map(async b => ({ tipo: b.type || 'image/jpeg', datos: await aBase64(b) })));
      const { data, error } = await sb.functions.invoke('leer-foto', { body: { prompt, imagenes } });
      if (opts.signal && opts.signal.aborted) throw err('cancelled');
      if (error) { let d = {}; try { d = await error.context.json(); } catch (e) { /* sin detalle */ } throw err(d.code || 'unavailable', d.error || error.message); }
      if (data && data.error) throw err(data.code || 'unknown', data.error);
      return data.json;
    },
  });

  // ---------- Panel del gerente: usuarios y PIN ----------
  async function panelUsuarios() {
    const ROLES = { gerente: 'Gerente', unico: 'Supervisor (hace todo)', calidad: 'Supervisor de calidad', produccion: 'Supervisor de producción', logistica: 'Supervisor de logística', deposito: 'Encargado de depósito', herreria: 'Supervisor de herrería', consulta: 'Consulta', direccion: 'Dirección' };
    const { data: lista } = await sb.from('perfiles').select('*').order('nombre');
    // Suplencias (acta 18/11/2026): roles adicionales, guardados en roles/<user_id>.extra
    const SUP = { produccion: 'Producción', calidad: 'Calidad', logistica: 'Logística', deposito: 'Depósito', herreria: 'Herrería' };
    const { data: rolesDocs } = await sb.from('docs').select('id,datos').eq('coleccion', 'roles');
    const extraDe = Object.fromEntries((rolesDocs || []).map(r => [r.id, (r.datos && r.datos.extra) || []]));
    let d = document.getElementById('propio-panel');
    if (!d) { d = document.createElement('dialog'); d.id = 'propio-panel'; document.body.appendChild(d); }
    const opts = sel => Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    d.innerHTML = `<div class="hoja"><h3>Usuarios y PIN</h3>
      <p class="ayuda" style="margin:0">Cada persona entra con su usuario y un PIN de 6 números o más. El rol define qué pestañas ve.</p>
      <div class="lista">${(lista || []).map(p => `<div class="caja" style="padding:10px"><b>${esc(p.nombre)}</b> · <span class="ayuda">${esc(p.usuario)}</span>${p.activo ? '' : ' <span class="etq bad">desactivado</span>'}
        <div class="previo-botones" style="margin:6px 0 0"><select data-urol="${p.user_id}">${opts(p.rol)}</select>
        <button class="btn" type="button" data-upin="${p.user_id}">Nuevo PIN</button>
        <button class="btn ${p.activo ? 'peligro' : ''}" type="button" data-uact="${p.user_id}" data-a="${p.activo ? 0 : 1}">${p.activo ? 'Desactivar' : 'Activar'}</button></div>
        ${p.rol === 'gerente' ? '' : `<fieldset class="chk" style="margin-top:6px"><legend>Suplente en</legend><div class="fila2">${Object.entries(SUP).map(([k, v]) => `<label class="op"><input type="checkbox" data-usup="${p.user_id}" value="${k}" ${(extraDe[p.user_id] || []).includes(k) ? 'checked' : ''}> ${v}</label>`).join('')}</div></fieldset>`}</div>`).join('')}</div>
      <fieldset class="chk"><legend>Nuevo usuario</legend>
        <label class="campo">Nombre<input id="pu-nombre" placeholder="Ej.: Javier González"></label>
        <label class="campo">Usuario<input id="pu-usuario" autocapitalize="none" placeholder="Ej.: javier"></label>
        <label class="campo">PIN (6 números o más)<input id="pu-pin" inputmode="numeric"></label>
        <label class="campo">Rol<select id="pu-rol">${opts('consulta')}</select></label>
        <button class="btn prim" type="button" id="pu-crear" style="margin-top:6px">Crear usuario</button></fieldset>
      <p class="ayuda" id="pu-msg" style="margin:0"></p>
      <div class="acciones"><button class="btn" type="button" id="pu-cerrar">Cerrar</button></div></div>`;
    if (!d.open) d.showModal();
    const msg = t => { d.querySelector('#pu-msg').textContent = t; };
    const llamar = async body => { const { data, error } = await sb.functions.invoke('usuarios', { body }); if (error) { let x = {}; try { x = await error.context.json(); } catch (e) { /* */ } throw new Error(x.error || error.message); } return data; };
    d.querySelector('#pu-cerrar').onclick = () => d.close();
    d.querySelector('#pu-crear').onclick = async () => {
      const b = { accion: 'crear', nombre: d.querySelector('#pu-nombre').value.trim(), usuario: d.querySelector('#pu-usuario').value.trim().toLowerCase(), pin: d.querySelector('#pu-pin').value.trim(), rol: d.querySelector('#pu-rol').value };
      if (!b.nombre || !b.usuario) return msg('Falta el nombre o el usuario.');
      if (!/^\d{6,}$/.test(b.pin)) return msg('El PIN tiene que tener 6 números o más.');
      try { await llamar(b); msg(`Listo: ${b.nombre} entra con el usuario "${b.usuario}".`); nombresCache = null; panelUsuarios(); } catch (e) { msg('No se pudo crear: ' + e.message); }
    };
    d.querySelectorAll('[data-urol]').forEach(s => s.onchange = async () => { try { await llamar({ accion: 'rol', user_id: s.dataset.urol, rol: s.value }); msg('Rol actualizado.'); } catch (e) { msg('No se pudo cambiar el rol: ' + e.message); } });
    d.querySelectorAll('[data-upin]').forEach(b => b.onclick = async () => {
      const pin = String(Math.floor(100000 + Math.random() * 900000));
      try { await llamar({ accion: 'pin', user_id: b.dataset.upin, pin }); msg(`PIN nuevo: ${pin}. Pasáselo en persona; no se vuelve a mostrar.`); } catch (e) { msg('No se pudo cambiar el PIN: ' + e.message); }
    });
    d.querySelectorAll('[data-usup]').forEach(c => c.onchange = async () => {
      const id = c.dataset.usup, extra = [...d.querySelectorAll('[data-usup]')].filter(x => x.dataset.usup === id && x.checked).map(x => x.value);
      const { error } = await sb.rpc('doc_actualizar', { p_coleccion: 'roles', p_id: id, p_parche: { extra } });
      if (error) { c.checked = !c.checked; return msg('No se pudo guardar la suplencia: ' + error.message); }
      msg(c.checked ? 'Suplencia agregada: ' + SUP[c.value] : 'Suplencia quitada');
    });
    d.querySelectorAll('[data-uact]').forEach(b => b.onclick = async () => { try { await llamar({ accion: 'activo', user_id: b.dataset.uact, activo: b.dataset.a === '1' }); panelUsuarios(); } catch (e) { msg(e.message); } });
  }

  // ---------- Lo que la app pide con window.claude.use(...) ----------
  // Descargas (PDF de la orden de producción): en la app propia el navegador guarda el archivo directo
  const downloads = {
    save: async ({ filename, data }) => {
      if (!filename || data == null) throw { code: 'bad_request', message: 'Falta el archivo' };
      const tipo = /\.pdf$/i.test(filename) ? 'application/pdf' : /\.csv$/i.test(filename) ? 'text/csv' : 'application/octet-stream';
      const blob = data instanceof Blob ? data : new Blob([data], { type: tipo });
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { status: 'saved' };
    },
  };
  const SERVICIOS = { db, user, assets, sample, downloads };
  window.claude = { use: async nombre => { await sesionLista; return SERVICIOS[nombre] || null; } };
})();

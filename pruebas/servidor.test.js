// Prueba del servidor con una hoja de cálculo simulada en memoria.
const fs = require('fs');
const hojas = {};
function Hoja(nombre) { this.nombre = nombre; this.f = []; }
Hoja.prototype = {
  getLastRow() { let n = this.f.length; while (n > 0 && this.f[n-1].every(v => v === '' || v == null)) n--; return n; },
  getLastColumn() { return Math.max(0, ...this.f.map(r => r.length)); },
  appendRow(v) { this.f[this.getLastRow()] = v.map(limpia); },
  deleteRow(n) { this.f.splice(n - 1, 1); },
  setFrozenRows() {},
  getRange(a, c, nr, nc) {
    const self = this;
    if (typeof a === 'string') return { setNumberFormat() {} };
    nr = nr || 1; nc = nc || 1;
    return {
      getValues() { const o = []; for (let i = 0; i < nr; i++) { const r = []; for (let j = 0; j < nc; j++) { const v = (self.f[a-1+i] || [])[c-1+j]; r.push(v == null ? '' : v); } o.push(r); } return o; },
      setValues(vals) { vals.forEach((r, i) => { self.f[a-1+i] = self.f[a-1+i] || []; r.forEach((v, j) => { self.f[a-1+i][c-1+j] = limpia(v); }); }); },
      setValue(v) { self.f[a-1] = self.f[a-1] || []; self.f[a-1][c-1] = limpia(v); },
      setNumberFormat() {},
    };
  },
};
function limpia(v) { return (typeof v === 'string' && v[0] === "'") ? v.slice(1) : v; } // el apóstrofo inicial marca texto
const p2 = n => String(n).padStart(2, '0');
global.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheetByName: n => hojas[n] || null, insertSheet: n => (hojas[n] = new Hoja(n)), getSpreadsheetTimeZone: () => 'local' }) };
global.Utilities = {
  getUuid: () => 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)),
  formatDate: d => d.getFullYear() + '-' + p2(d.getMonth()+1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()),
  parseDate: s => { const m = s.match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)/).map(Number); return new Date(m[1], m[2]-1, m[3], m[4], m[5], m[6]); },
};
global.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
global.ContentService = { MimeType: { JSON: 'json' }, createTextOutput: t => ({ t, setMimeType() { return this; } }) };
const src = fs.readFileSync(__dirname + '/../servidor/Codigo.gs', 'utf8').replace("CAMBIA-ESTA-CLAVE", 'k');
const api = new Function(src + '; return { doPost, doGet };')();
const post = o => JSON.parse(api.doPost({ postData: { contents: JSON.stringify(o) } }).t);
let fallos = 0; const ok = (c, m) => { if (!c) { fallos++; console.log('FALLO', m); } else console.log('ok   ', m); };

// hoja antigua: cabecera de 7 columnas y una fila sin ID (como la que ya existe)
hojas.Gastos = new Hoja('Gastos');
hojas.Gastos.f = [['Fecha','Comercio','Importe','Tarjeta','Categoría','Origen','Importe original'], [new Date(2026,9,9,16,59,40),'PRUEBA Mercadona',12.5,'Tarjeta de prueba','Supermercado','Prueba','12,50€']];

ok(post({ clave: 'mala', accion: 'leer' }).error === 'Clave incorrecta', 'rechaza clave incorrecta');
ok(JSON.parse(api.doPost({ postData: { contents: 'no json' } }).t).ok === false, 'rechaza cuerpo no válido');
let t = post({ clave: 'k', accion: 'leer' });
ok(t.ok && t.gastos.length === 1 && t.gastos[0].fecha === '2026-10-09T16:59:40' && t.gastos[0].id, 'lee la fila antigua y le pone ID');
ok(hojas.Gastos.f[0][7] === 'ID' && hojas.Gastos.f[0][8] === 'Cuenta' && hojas.Gastos.f[1][7] === t.gastos[0].id, 'amplía la cabecera y guarda el ID');
ok(post({ clave: 'k', accion: 'leer' }).gastos[0].id === t.gastos[0].id, 'el ID es estable entre lecturas');

// webhook del iPhone (sin accion), igual que hoy
let w = post({ clave: 'k', comercio: 'E.S. Repsol', importe: '45,30 €', tarjeta: 'Santander Débito' });
ok(w.ok && w.importe === 45.3, 'webhook: apunta el pago');
t = post({ clave: 'k', accion: 'leer' });
ok(t.gastos.length === 2 && t.gastos[1].categoria === 'Gasolina' && t.gastos[1].origen === 'Apple Pay' && t.gastos[1].tarjeta === 'Santander Débito', 'webhook: categoría, origen y tarjeta');
w = post({ clave: 'k', comercio: '=HYPERLINK("x")', importe: '', tarjeta: '' });
t = post({ clave: 'k', accion: 'leer' });
ok(t.gastos[2].comercio === '=HYPERLINK("x")' && t.gastos[2].categoria === 'Otros' && t.gastos[2].importe === 0, 'webhook: texto con = se guarda como texto; importe vacío = 0; categoría por defecto');
ok(typeof hojas.Gastos.f[3][1] === 'string', 'no es fórmula');

// gastos desde la app
let g = post({ clave: 'k', accion: 'gasto.guardar', gasto: { id: 'gabc', fecha: '2026-10-09T18:20:11', comercio: 'Bar', importe: 7.5, categoria: 'Restaurantes', cuenta: 'banco-santander', origen: 'A mano' } });
t = post({ clave: 'k', accion: 'leer' });
let x = t.gastos.find(q => q.id === 'gabc');
ok(g.ok && x && x.fecha === '2026-10-09T18:20:11' && x.importe === 7.5 && x.cuenta === 'banco-santander' && x.origen === 'A mano', 'app: alta de gasto');
post({ clave: 'k', accion: 'gasto.guardar', gasto: { id: 'gabc', fecha: '2026-10-08T09:00', comercio: 'Bar 2', importe: '9,10', categoria: 'Ocio', cuenta: '' } });
t = post({ clave: 'k', accion: 'leer' }); x = t.gastos.find(q => q.id === 'gabc');
ok(t.gastos.length === 4 && x.fecha === '2026-10-08T09:00:00' && x.importe === 9.1 && x.comercio === 'Bar 2' && x.categoria === 'Ocio' && x.cuenta === '', 'app: cambio de gasto sin duplicar');
const idRepsol = t.gastos[1].id;
post({ clave: 'k', accion: 'gasto.guardar', gasto: { id: idRepsol, fecha: t.gastos[1].fecha, comercio: 'E.S. Repsol', importe: 45.3, categoria: 'Gasolina', cuenta: 'revolut-conjunta', tarjeta: 'Santander Débito', origen: 'Apple Pay' } });
ok(hojas.Gastos.f[2][6] === '45,30 €' && hojas.Gastos.f[2][8] === 'revolut-conjunta', 'app: editar un pago conserva el importe original');
let b = post({ clave: 'k', accion: 'gasto.borrar', id: 'gabc' });
t = post({ clave: 'k', accion: 'leer' });
ok(b.borrado && t.gastos.length === 3 && !t.gastos.find(q => q.id === 'gabc'), 'app: borra el gasto');
ok(post({ clave: 'k', accion: 'gasto.borrar', id: 'noexiste' }).borrado === false, 'borrar algo inexistente no rompe');

// presupuestos
post({ clave: 'k', accion: 'presupuesto.guardar', presupuesto: { id: 'ocio', nombre: 'Ocio', limite: 80, orden: 6 } });
post({ clave: 'k', accion: 'presupuesto.guardar', presupuesto: { id: 'salud', nombre: 'Salud', limite: 50, orden: 7 } });
post({ clave: 'k', accion: 'presupuesto.guardar', presupuesto: { id: 'ocio', nombre: 'Ocio', limite: 95.5, orden: 6 } });
t = post({ clave: 'k', accion: 'leer' });
ok(t.presupuestos.length === 2 && t.presupuestos[0].limite === 95.5, 'presupuestos: alta y cambio');
post({ clave: 'k', accion: 'presupuesto.borrar', id: 'ocio' });
ok(post({ clave: 'k', accion: 'leer' }).presupuestos.map(p => p.id).join() === 'salud', 'presupuestos: borrado');

// cuentas
post({ clave: 'k', accion: 'cuenta.guardar', cuenta: { id: 'banco-santander', nombre: 'Banco Santander', saldo: 144.01, fechaSaldo: '2026-10-09T18:02:22', tarjetas: ['Santander', 'Visa, Oro'], orden: 1 } });
post({ clave: 'k', accion: 'cuenta.guardar', cuenta: { id: 'tr', nombre: 'Trade Republic', saldo: null, fechaSaldo: '', tarjetas: [], orden: 3 } });
t = post({ clave: 'k', accion: 'leer' });
ok(t.cuentas.length === 2 && t.cuentas[0].saldo === 144.01 && t.cuentas[0].fechaSaldo === '2026-10-09T18:02:22' && t.cuentas[0].tarjetas.join('|') === 'Santander|Visa  Oro' && t.cuentas[1].saldo === null && t.cuentas[1].tarjetas.length === 0, 'cuentas: alta, saldo vacío y tarjetas');
post({ clave: 'k', accion: 'cuenta.guardar', cuenta: { id: 'tr', nombre: 'Trade Republic', saldo: 0, fechaSaldo: '2026-10-09T19:00:00', tarjetas: ['Trade Republic'], orden: 3 } });
ok(post({ clave: 'k', accion: 'leer' }).cuentas[1].saldo === 0, 'cuentas: saldo 0 no se confunde con vacío');
post({ clave: 'k', accion: 'cuenta.borrar', id: 'tr' });
ok(post({ clave: 'k', accion: 'leer' }).cuentas.length === 1, 'cuentas: borrado');
ok(post({ clave: 'k', accion: 'inventada' }).ok === false, 'acción desconocida');
ok(JSON.parse(api.doGet().t).ok, 'doGet responde');
console.log(fallos ? fallos + ' FALLOS' : 'TODO OK'); process.exit(fallos ? 1 : 0);

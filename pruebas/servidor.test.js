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
      getValue() { const v = (self.f[a-1] || [])[c-1]; return v == null ? '' : v; },
      setValue(v) { self.f[a-1] = self.f[a-1] || []; self.f[a-1][c-1] = limpia(v); },
      setNumberFormat() {},
    };
  },
};
function limpia(v) { return (typeof v === 'string' && v[0] === "'") ? v.slice(1) : v; } // el apóstrofo inicial marca texto
const p2 = n => String(n).padStart(2, '0');
global.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheetByName: n => hojas[n] || null, insertSheet: n => (hojas[n] = new Hoja(n)), getSpreadsheetTimeZone: () => 'local' }) };
global.Utilities = {
  base64DecodeWebSafe: t => { if (typeof t !== 'string') throw new Error('Could not decode string.'); return Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); },
  newBlob: b => ({ getDataAsString: () => Buffer.from(b).toString('utf8') }),
  getUuid: () => 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)),
  formatDate: (d, z, f) => d.getFullYear() + '-' + p2(d.getMonth()+1) + '-' + p2(d.getDate()) + (f === 'yyyy-MM-dd' ? '' : 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())),
  parseDate: s => { const m = s.match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)/).map(Number); return new Date(m[1], m[2]-1, m[3], m[4], m[5], m[6]); },
};
const correos = []; const props = {}; const disparadores = []; let gmailRoto = false;
const b64 = t => Buffer.from(t, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
global.Gmail = { Users: { Messages: {
  list: (yo, o) => { if (gmailRoto) throw new Error('Sin permiso para Gmail'); return { messages: correos.filter(c => o.q.indexOf(c.de) > -1).map(c => ({ id: c.id })).reverse() }; },
  get: (yo, id) => { const c = correos.find(x => x.id === id); return { id, internalDate: String(c.t), snippet: '', payload: { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: c.id === 'e2' ? b64(c.html) : Array.from(Buffer.from(c.html, 'utf8')) } }] } }; },
} } };
global.PropertiesService = { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) };
global.ScriptApp = { getProjectTriggers: () => disparadores.map(f => ({ getHandlerFunction: () => f })), newTrigger: f => ({ timeBased() { return this; }, everyMinutes() { return this; }, create() { disparadores.push(f); } }) };
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
w = post({ clave: 'k', comercio: '', importe: '', tarjeta: '' });
ok(w.ok && w.prueba === true && /Conexión correcta/.test(w.mensaje) && post({ clave: 'k', accion: 'leer' }).gastos.length === 3, 'webhook: una prueba vacía contesta que hay conexión y no apunta nada');
w = post({ clave: 'k' });
ok(w.ok && w.prueba === true && post({ clave: 'k', accion: 'leer' }).gastos.length === 3, 'webhook: tampoco apunta nada si solo llega la clave');

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
// tipos de movimiento
ok(hojas.Gastos.f[0][9] === 'Tipo' && hojas.Gastos.f[0][10] === 'Cuenta destino', 'cabecera con Tipo y Cuenta destino');
t = post({ clave: 'k', accion: 'leer' });
ok(t.gastos.every(q => q.tipo === 'gasto' && q.destino === ''), 'las filas antiguas y los pagos son gastos');
post({ clave: 'k', accion: 'gasto.guardar', gasto: { id: 'gi1', fecha: '2026-10-09T19:00:00', comercio: 'Nómina', importe: 1500, categoria: 'Ocio', cuenta: 'banco-santander', tipo: 'ingreso', origen: 'Ingreso' } });
post({ clave: 'k', accion: 'gasto.guardar', gasto: { id: 'gt1', fecha: '2026-10-09T19:01:00', comercio: 'Ahorro', importe: 200, cuenta: 'banco-santander', tipo: 'traspaso', destino: 'trade-republic', origen: 'Entre cuentas' } });
post({ clave: 'k', accion: 'gasto.guardar', gasto: { id: 'gb1', fecha: '2026-10-09T19:02:00', comercio: 'Cena', importe: 20, categoria: 'Restaurantes', cuenta: 'revolut-conjunta', tipo: 'gasto', destino: 'x', origen: 'Bizum' } });
post({ clave: 'k', accion: 'gasto.guardar', gasto: { id: 'gr1', fecha: '2026-10-09T19:03:00', comercio: 'Raro', importe: 1, categoria: 'Ocio', cuenta: '', tipo: 'inventado' } });
t = post({ clave: 'k', accion: 'leer' }); const por = id => t.gastos.find(q => q.id === id);
ok(por('gi1').tipo === 'ingreso' && por('gi1').categoria === '' && por('gi1').cuenta === 'banco-santander', 'ingreso: se guarda sin categoría');
ok(por('gt1').tipo === 'traspaso' && por('gt1').destino === 'trade-republic' && por('gt1').categoria === '', 'traspaso: guarda la cuenta destino');
ok(por('gb1').tipo === 'gasto' && por('gb1').destino === '' && por('gb1').origen === 'Bizum' && por('gb1').categoria === 'Restaurantes', 'bizum: es un gasto con su categoría y sin destino');
ok(por('gr1').tipo === 'gasto', 'un tipo desconocido se trata como gasto');
post({ clave: 'k', accion: 'gasto.guardar', gasto: { id: 'gt1', fecha: '2026-10-09T19:01:00', comercio: 'Ahorro', importe: 250, cuenta: 'banco-santander', tipo: 'ingreso', destino: 'trade-republic' } });
t = post({ clave: 'k', accion: 'leer' });
ok(por('gt1').tipo === 'ingreso' && por('gt1').destino === '' && por('gt1').importe === 250, 'cambiar de traspaso a ingreso limpia el destino');
ok(post({ clave: 'k', accion: 'inventada' }).ok === false, 'acción desconocida');
ok(JSON.parse(api.doGet().t).ok, 'doGet responde');

// ---------------------------------------------------------------- avisos del banco por correo
const DE = 'SantanderInforma@emailing.bancosantander-mail.es';
const hora = (h, m, sg) => new Date(2026, 9, 9, h, m, sg || 0).getTime();
const aviso = (id, t, importe, fin) => correos.push({ id, de: DE, t, html: '<style>p{color:red}</style><p>Si no visualizas correctamente este email haz click aqu&iacute;</p><p>Antonio, te informamos de que <b>tienes disponible ' + importe + ' EUR en tu cuenta</b> terminada en **' + (fin || '0061') + '.</p>' });
const realNow = Date.now; let reloj = hora(19, 10); Date.now = () => reloj;
hojas.Gastos.f = [hojas.Gastos.f[0]]; hojas.Cuentas.f = [hojas.Cuentas.f[0]];
post({ clave: 'k', accion: 'cuenta.guardar', cuenta: { id: 'banco-santander', nombre: 'Banco Santander', saldo: 144.01, fechaSaldo: '2026-10-09T18:02:22', tarjetas: ['Santander'], orden: 1, terminaEn: '0061' } });
post({ clave: 'k', accion: 'cuenta.guardar', cuenta: { id: 'revolut', nombre: 'Revolut', saldo: 50, fechaSaldo: '2026-10-09T18:02:46', tarjetas: ['Revolut'], orden: 2 } });
hojas.Gastos.f.push([new Date(2026, 9, 9, 18, 30, 0), 'Repsol', 10, 'Santander Débito', 'Gasolina', 'Apple Pay', '10,00 €', 'gap1', '', 'gasto', '']);
aviso('e0', hora(16, 53), '150,00');             // anterior al saldo anotado: no cuenta
aviso('e1', hora(18, 55), '135,01');             // 144,01 - 10 = 134,01 -> entra 1,00
correos.push({ id: 'e4', de: DE, t: hora(19, 0), html: '<p>Descubre nuestras ofertas</p>' });
aviso('e9', hora(19, 1), '999,00', '9999');      // cuenta que no existe
aviso('e2', hora(19, 2), '133,00');              // salen 2,01
aviso('e3', hora(19, 9, 30), '133,00');          // demasiado reciente a las 19:10
t = post({ clave: 'k', accion: 'leer' });
let cs = t.cuentas.find(q => q.id === 'banco-santander'); const mov = t.gastos.filter(q => q.origen === 'Banco');
ok(t.correo.ok && t.correo.aplicados === 2 && t.correo.nuevos === 5, 'correo: procesa los avisos pendientes (' + JSON.stringify(t.correo) + ')');
ok(cs.saldo === 133 && cs.fechaSaldo === '2026-10-09T19:03:00' && cs.terminaEn === '0061', 'correo: la cuenta queda con el saldo del banco (' + cs.saldo + ' @ ' + cs.fechaSaldo + ')');
ok(mov.length === 2 && mov[0].tipo === 'ingreso' && mov[0].importe === 1 && mov[0].fecha === '2026-10-09T18:55:00' && mov[0].cuenta === 'banco-santander' && mov[0].comercio === 'Sin identificar' && mov[0].categoria === '', 'correo: la entrada de 1,00 se apunta como ingreso sin identificar');
ok(mov[1].tipo === 'gasto' && mov[1].importe === 2.01 && mov[1].categoria === 'Otros' && mov[1].fecha === '2026-10-09T19:02:00', 'correo: la salida de 2,01 se apunta como gasto sin identificar');
ok(t.cuentas.find(q => q.id === 'revolut').saldo === 50, 'correo: no toca otras cuentas');
ok(disparadores.join() === 'tareaCorreo', 'correo: crea el disparador');
t = post({ clave: 'k', accion: 'leer' });
ok(t.correo.nuevos === 0 && t.gastos.filter(q => q.origen === 'Banco').length === 2 && disparadores.length === 1, 'correo: repetir no duplica nada');
reloj = hora(19, 12); t = post({ clave: 'k', accion: 'leer' }); cs = t.cuentas.find(q => q.id === 'banco-santander');
ok(t.correo.aplicados === 1 && cs.saldo === 133 && cs.fechaSaldo === '2026-10-09T19:10:30' && t.gastos.filter(q => q.origen === 'Banco').length === 2, 'correo: un aviso que cuadra solo confirma el saldo');
// pago con tarjeta cuyo apunte llega un poco después del aviso que ya lo incluye
aviso('e5', hora(19, 20), '128,00');
hojas.Gastos.f.push([new Date(2026, 9, 9, 19, 20, 40), 'Bar', 5, 'Santander Débito', 'Restaurantes', 'Apple Pay', '5,00 €', 'gap2', '', 'gasto', '']);
reloj = hora(19, 30); t = post({ clave: 'k', accion: 'leer' }); cs = t.cuentas.find(q => q.id === 'banco-santander');
ok(cs.saldo === 128 && cs.fechaSaldo === '2026-10-09T19:21:00' && t.gastos.filter(q => q.origen === 'Banco').length === 2, 'correo: el pago de Apple Pay no se cuenta dos veces');
// la app guarda la cuenta sin saber las 4 cifras: se conservan
post({ clave: 'k', accion: 'cuenta.guardar', cuenta: { id: 'banco-santander', nombre: 'Banco Santander', saldo: 500, fechaSaldo: '2026-10-09T19:40:00', tarjetas: ['Santander'], orden: 1 } });
delete props.correoHechos;   // aunque se olvide lo ya leído, los avisos viejos no pisan un saldo más nuevo
reloj = hora(19, 45); t = post({ clave: 'k', accion: 'leer' }); cs = t.cuentas.find(q => q.id === 'banco-santander');
ok(cs.terminaEn === '0061' && cs.saldo === 500 && t.correo.aplicados === 0 && t.gastos.filter(q => q.origen === 'Banco').length === 2, 'correo: conserva las 4 cifras y no aplica avisos anteriores al saldo anotado');
// tarea programada
aviso('e6', hora(19, 50), '480,00'); reloj = hora(19, 55);
new Function(src + '; return tareaCorreo;')()();
t = post({ clave: 'k', accion: 'leer' }); cs = t.cuentas.find(q => q.id === 'banco-santander');
ok(cs.saldo === 480 && t.gastos.filter(q => q.origen === 'Banco' && q.importe === 20 && q.tipo === 'gasto').length === 1, 'correo: la tarea programada también lo aplica');
gmailRoto = true; t = post({ clave: 'k', accion: 'leer' });
ok(t.ok && t.correo.ok === false && /permiso/.test(t.correo.error) && t.cuentas.length === 2, 'correo: si falla Gmail, la app sigue funcionando');
w = post({ clave: 'k', comercio: 'Mercadona', importe: '3,00 €', tarjeta: 'Santander Débito' });
ok(w.ok, 'correo: si falla Gmail, el webhook sigue funcionando');
// la hoja devuelve la fecha del saldo con espacio o como fecha: se normaliza
gmailRoto = false;
hojas.Cuentas.f[1][3] = '2026-10-09 18:02:22'; hojas.Cuentas.f[2][3] = new Date(2026, 9, 9, 18, 2, 46);
t = post({ clave: 'k', accion: 'leer' });
ok(t.cuentas[0].fechaSaldo === '2026-10-09T18:02:22' && t.cuentas[1].fechaSaldo === '2026-10-09T18:02:46', 'la fecha del saldo sale siempre con T (' + t.cuentas[0].fechaSaldo + ', ' + t.cuentas[1].fechaSaldo + ')');
post({ clave: 'k', accion: 'cuenta.guardar', cuenta: { id: 'revolut', nombre: 'Revolut', saldo: 50, fechaSaldo: '2026-10-09 20:00', tarjetas: [], orden: 2 } });
ok(hojas.Cuentas.f[2][3] === '2026-10-09T20:00:00', 'al guardar, la fecha del saldo se normaliza');

// ---------------------------------------------------------------- papel de cada cuenta e historial de saldos
post({ clave: 'k', accion: 'cuenta.guardar', cuenta: { id: 'tr', nombre: 'Trade Republic', saldo: 4000, fechaSaldo: '2026-10-09T20:00:00', tarjetas: [], orden: 3, rol: 'ahorro', objetivo: 6000 } });
post({ clave: 'k', accion: 'cuenta.guardar', cuenta: { id: 'mi', nombre: 'MyInvestor', saldo: 9000, fechaSaldo: '2026-10-09T20:00:00', tarjetas: [], orden: 4, rol: 'inversion', aportado: 8000, fechaAportado: '2026-10-09 20:00' } });
post({ clave: 'k', accion: 'cuenta.guardar', cuenta: { id: 'revolut', nombre: 'Revolut', saldo: 50, fechaSaldo: '2026-10-09T20:00:00', tarjetas: [], orden: 2, rol: 'cualquiera' } });
t = post({ clave: 'k', accion: 'leer' });
let ct = id => t.cuentas.find(q => q.id === id);
ok(ct('tr').rol === 'ahorro' && ct('tr').objetivo === 6000 && ct('tr').aportado === null && ct('mi').rol === 'inversion' && ct('mi').aportado === 8000 && ct('mi').fechaAportado === '2026-10-09T20:00:00' && ct('revolut').rol === '' && ct('banco-santander').rol === '', 'cuentas: papel, objetivo y aportado (un papel desconocido se queda vacío)');
ok(hojas.Cuentas.f[0][7] === 'Rol' && hojas.Cuentas.f[0][10] === 'Fecha aportado', 'cuentas: la cabecera se amplía sola');
post({ clave: 'k', accion: 'cuenta.guardar', cuenta: { id: 'tr', nombre: 'Trade Republic', saldo: 4100, fechaSaldo: '2026-10-09T21:00:00', tarjetas: [], orden: 3 } });   // una app antigua no manda los campos nuevos
post({ clave: 'k', accion: 'cuenta.guardar', cuenta: { id: 'mi', nombre: 'MyInvestor', saldo: 9000, fechaSaldo: '2026-10-09T20:00:00', tarjetas: [], orden: 4, rol: 'inversion', objetivo: null, aportado: null, fechaAportado: '' } });
t = post({ clave: 'k', accion: 'leer' });
ok(ct('tr').saldo === 4100 && ct('tr').rol === 'ahorro' && ct('tr').objetivo === 6000 && ct('mi').aportado === null && ct('mi').fechaAportado === '', 'cuentas: lo que no se manda se conserva y lo que se manda vacío se borra');
post({ clave: 'k', accion: 'cuenta.guardar', cuenta: Object.assign({}, ct('banco-santander'), { rol: 'gasto' }) });
aviso('e7', hora(19, 55), '470,00'); reloj = hora(20, 30);
ok(hojas.Saldos && hojas.Saldos.f.length === 2, 'saldos: ya había una foto de las lecturas anteriores');
delete props.fotoDia; delete hojas.Saldos;
t = post({ clave: 'k', accion: 'leer' });
ok(ct('banco-santander').saldo === 470 && ct('banco-santander').rol === 'gasto' && ct('banco-santander').terminaEn === '0061', 'correo: un aviso del banco no borra el papel de la cuenta');
const hoyTxt = (() => { const d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); })();
ok(t.saldos.length === 1 && t.saldos[0].dia === hoyTxt && typeof t.saldos[0].cuentas.tr === 'number' && Object.keys(t.saldos[0].cuentas).length === 4, 'saldos: la primera lectura del día guarda una foto (' + JSON.stringify(t.saldos[0]) + ')');
const f1 = t.saldos[0];
post({ clave: 'k', accion: 'gasto.guardar', gasto: { id: 'gtr9', fecha: '2026-10-09T23:00:00', comercio: 'Traspaso a Trade Republic', importe: 100, tipo: 'traspaso', cuenta: 'banco-santander', destino: 'tr', origen: 'Banco' } });
t = post({ clave: 'k', accion: 'leer' });
ok(t.saldos.length === 1 && hojas.Saldos.f.length === 2, 'saldos: no se repite el mismo día');
props.fotoDia = '2000-01-01'; hojas.Saldos.f[1][0] = '2026-10-01';
api.tareaCorreo ? 0 : 0; t = post({ clave: 'k', accion: 'leer' });
ok(t.saldos.length === 2 && t.saldos[0].dia === '2026-10-01' && t.saldos[1].dia === hoyTxt && t.saldos[1].cuentas.tr === f1.cuentas.tr + 100 && t.saldos[1].cuentas['banco-santander'] === f1.cuentas['banco-santander'] - 100 && Math.abs(t.saldos[1].total - f1.total) < 0.005, 'saldos: al día siguiente se añade otra foto y los traspasos mueven el saldo de las dos cuentas (' + JSON.stringify(t.saldos[1].cuentas) + ')');
hojas.Saldos.f[1][2] = 'no es json'; gmailRoto = true;
t = post({ clave: 'k', accion: 'leer' });
ok(t.ok && t.saldos.length === 2 && Object.keys(t.saldos[0].cuentas).length === 0, 'saldos: una fila estropeada no rompe la lectura');
gmailRoto = false;

// ---------------------------------------------------------------- fondos de la cuenta de inversión
ok(post({ clave: 'k', accion: 'fondo.guardar', fondo: { id: 'no-es-isin', participaciones: 1 } }).ok === false, 'fondos: rechaza un ISIN que no lo es');
post({ clave: 'k', accion: 'fondo.guardar', fondo: { id: 'ie00byx5mx67', nombre: 'Fidelity S&P 500', cuenta: 'mi', participaciones: 100, fechaParticipaciones: '2026-10-10T16:00:00', precio: 17.13, fechaPrecio: '2026-10-08' } });
t = post({ clave: 'k', accion: 'leer' });
ok(t.fondos.length === 1 && t.fondos[0].id === 'IE00BYX5MX67' && t.fondos[0].participaciones === 100 && t.fondos[0].precio === 17.13 && t.fondos[0].fechaPrecio === '2026-10-08' && ct('mi').saldo === 1713 && ct('mi').fechaSaldo === '2026-10-10T16:00:00' && ct('mi').rol === 'inversion', 'fondos: la cuenta pasa a valer participaciones x precio, con la fecha de las participaciones');
post({ clave: 'k', accion: 'fondo.guardar', fondo: { id: 'ES0165265002', nombre: 'MyInvestor Nasdaq 100', cuenta: 'mi', participaciones: 500.82, fechaParticipaciones: '2026-10-10T16:05:00' } });
t = post({ clave: 'k', accion: 'leer' });
ok(t.fondos.length === 2 && t.fondos[1].precio === null && ct('mi').saldo === 1713, 'fondos: si a un fondo le falta el precio, el valor de la cuenta no se toca');
const filaNasdaq = hojas.Fondos.f.findIndex(f => f[0] === 'ES0165265002');
hojas.Fondos.f[filaNasdaq][7] = 1.83; hojas.Fondos.f[filaNasdaq][8] = 'Fecha de valor liquidativo: 7/10/2026';
hojas.Fondos.f[1][7] = '#REF!';
t = post({ clave: 'k', accion: 'leer' });
ok(t.fondos[1].precio === 1.83 && t.fondos[1].fechaPrecio === '2026-10-07' && t.fondos[0].precio === 17.13 && ct('mi').saldo === Math.round((100 * 17.13 + 500.82 * 1.83) * 100) / 100 && ct('mi').fechaSaldo === '2026-10-10T16:05:00', 'fondos: lo que lee la fórmula pasa a ser el precio; un error de la fórmula deja el precio anterior (' + ct('mi').saldo + ')');
hojas.Fondos.f[1][7] = 17.5; hojas.Fondos.f[1][8] = new Date(2026, 9, 9);
api.doPost({ postData: { contents: JSON.stringify({ clave: 'k', accion: 'leer' }) } });
post({ clave: 'k', accion: 'fondo.guardar', fondo: { id: 'IE00BYX5MX67', participaciones: 110, fechaParticipaciones: '2026-10-11T09:00:00' } });   // la app solo manda lo que cambia
t = post({ clave: 'k', accion: 'leer' });
ok(t.fondos[0].precio === 17.5 && t.fondos[0].fechaPrecio === '2026-10-09' && t.fondos[0].nombre === 'Fidelity S&P 500' && t.fondos[0].cuenta === 'mi' && t.fondos[0].participaciones === 110 && hojas.Fondos.f[1][7] === 17.5 && ct('mi').saldo === Math.round((110 * 17.5 + 500.82 * 1.83) * 100) / 100 && ct('mi').fechaSaldo === '2026-10-11T09:00:00', 'fondos: cambiar las participaciones conserva nombre, precio y fórmulas, y recalcula');
post({ clave: 'k', accion: 'fondo.borrar', id: 'ES0165265002' });
t = post({ clave: 'k', accion: 'leer' });
ok(t.fondos.length === 1 && ct('mi').saldo === 1925, 'fondos: al quitar un fondo la cuenta se recalcula con los que quedan');
Date.now = realNow;
console.log(fallos ? fallos + ' FALLOS' : 'TODO OK'); process.exit(fallos ? 1 : 0);

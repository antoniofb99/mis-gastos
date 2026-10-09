/**
 * Mis Gastos: servidor que vive en la hoja de cálculo.
 *
 * Hace dos cosas, siempre por POST y con la clave en el cuerpo:
 *  1) Webhook: recibe cada pago de Apple Pay desde Atajos (iPhone) y lo apunta en "Gastos".
 *  2) API de la app: lee y guarda movimientos (gastos, ingresos y traspasos), presupuestos y cuentas.
 *  3) Avisos del banco: lee en Gmail (solo lectura) los correos que dicen cuánto hay disponible
 *     en una cuenta, pone ese saldo y apunta la diferencia como movimiento sin identificar.
 *
 * Tras cambiar este archivo hay que publicar una versión nueva en
 * Implementar -> Gestionar implementaciones (la URL no cambia).
 */

// El atajo del iPhone y la app deben enviar esta misma clave.
const CLAVE = 'CAMBIA-ESTA-CLAVE';

// Tipo: gasto (resta de Cuenta), ingreso (suma a Cuenta) o traspaso (pasa de Cuenta a Cuenta destino).
const H_GASTOS = ['Fecha', 'Comercio', 'Importe', 'Tarjeta', 'Categoría', 'Origen', 'Importe original', 'ID', 'Cuenta', 'Tipo', 'Cuenta destino'];
const TIPOS = ['gasto', 'ingreso', 'traspaso'];
const H_PRESUPUESTOS = ['ID', 'Nombre', 'Límite', 'Orden'];
// Termina en: las 4 últimas cifras de la cuenta, para saber a cuál se refiere cada aviso del banco.
const H_CUENTAS = ['ID', 'Nombre', 'Saldo', 'Fecha saldo', 'Tarjetas', 'Orden', 'Termina en'];

// Avisos de saldo por correo. El texto es del tipo:
// "te informamos de que tienes disponible 143,00 EUR en tu cuenta terminada en **0061."
const AVISOS = [{
  banco: 'Santander',
  remitente: 'SantanderInforma@emailing.bancosantander-mail.es',
  patron: /disponible\s+(?:de\s+)?([\d.,]+)\s*(?:EUR|€)\s+en\s+tu\s+cuenta\s+terminada\s+en\s+[*\s]*(\d{4})/i,
}];
const AVISO_ESPERA_S = 90;   // no se procesa un aviso hasta que tiene esta antigüedad: da tiempo a que llegue el pago de Apple Pay
const AVISO_MARGEN_S = 60;   // los movimientos apuntados hasta este rato después del aviso se dan por incluidos en su saldo
const ORIGEN_BANCO = 'Banco';
const SIN_IDENTIFICAR = 'Sin identificar';
const F_FECHA = "yyyy-MM-dd'T'HH:mm:ss";

// Reglas de categoría para los pagos que llegan solos: si el nombre del comercio
// contiene alguna de las palabras (sin distinguir mayúsculas ni tildes), se asigna
// esa categoría. Gana la primera coincidencia. Una palabra entre espacios (' dia ')
// solo coincide como palabra suelta, así "Media Markt" no cuenta como supermercado DIA.
const CATEGORIAS = [
  ['Supermercado', ['mercadona', 'lidl', 'carrefour', 'aldi', ' dia ', 'alcampo', 'eroski', 'consum', 'supersol', 'coviran', 'masymas', ' mas ']],
  ['Gasolina', ['repsol', 'cepsa', 'moeve', ' bp ', 'shell', 'galp', 'petroprix', 'plenoil', 'ballenoil', 'gasolinera', 'e.s.']],
  ['Restaurantes', ['restaurante', ' bar ', 'cafeteria', ' cafe ', 'burger', 'mcdonald', 'kfc', 'telepizza', 'domino', 'glovo', 'just eat', 'uber eats', 'cerveceria', 'meson', ' venta ']],
  ['Transporte', ['renfe', 'uber', 'cabify', 'bolt', 'taxi', 'parking', 'aparcamiento', 'peaje', 'autopista', 'alsa']],
  ['Compras', ['amazon', 'zara', 'decathlon', 'el corte ingles', 'ikea', 'leroy', 'mediamarkt', 'media markt', 'primark', 'aliexpress']],
  ['Salud', ['farmacia', 'clinica', 'fisio', 'dental', 'optica']],
  ['Ocio', [' cine', 'cines', 'spotify', 'netflix', 'hbo', 'disney', 'steam', 'playstation', 'ticketmaster']],
];
const CATEGORIA_POR_DEFECTO = 'Otros';

/* ------------------------------------------------------------------ entrada */

function doPost(e) {
  let datos;
  try {
    datos = JSON.parse(e.postData.contents);
  } catch (err) {
    return responder({ ok: false, error: 'Petición no válida' });
  }
  if (!datos || datos.clave !== CLAVE) {
    return responder({ ok: false, error: 'Clave incorrecta' });
  }

  const candado = LockService.getScriptLock();
  try {
    candado.waitLock(20000);
    switch (datos.accion || 'pago') {
      case 'pago': return responder(apuntarPago(datos));
      case 'leer': {
        const correo = sincronizarSinRomper();
        const todo = leerTodo();
        todo.correo = correo;
        return responder(todo);
      }
      case 'gasto.guardar': return responder(guardarGasto(datos.gasto));
      case 'gasto.borrar': return responder(borrarFila('Gastos', H_GASTOS, 8, datos.id));
      case 'presupuesto.guardar': return responder(guardarPresupuesto(datos.presupuesto));
      case 'presupuesto.borrar': return responder(borrarFila('Presupuestos', H_PRESUPUESTOS, 1, datos.id));
      case 'cuenta.guardar': return responder(guardarCuenta(datos.cuenta));
      case 'cuenta.borrar': return responder(borrarFila('Cuentas', H_CUENTAS, 1, datos.id));
      default: return responder({ ok: false, error: 'Acción desconocida' });
    }
  } catch (err) {
    return responder({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    try { candado.releaseLock(); } catch (err) { /* no lo teníamos */ }
  }
}

// Abrir la URL en el navegador solo sirve para comprobar que el despliegue funciona.
function doGet() {
  return responder({ ok: true, mensaje: 'Webhook de gastos activo' });
}

/* ------------------------------------------------------------------- gastos */

// Pago que llega desde Atajos: { comercio, importe, tarjeta, origen? }
function apuntarPago(datos) {
  const comercio = String(datos.comercio || '').trim();
  const importeOriginal = String(datos.importe == null ? '' : datos.importe).trim();
  const importe = leerImporte(importeOriginal);
  const id = nuevoId();
  hoja('Gastos', H_GASTOS).appendRow([
    new Date(),
    texto(comercio),
    importe,
    texto(String(datos.tarjeta || '').trim()),
    categorizar(comercio),
    texto(datos.origen || 'Apple Pay'),
    texto(importeOriginal),
    id,
    '',
    'gasto',
    '',
  ]);
  return { ok: true, id: id, comercio: comercio, importe: importe };
}

function leerGastos() {
  const h = hoja('Gastos', H_GASTOS);
  const n = h.getLastRow() - 1;
  if (n < 1) return [];
  const zona = zonaHoraria();
  const filas = h.getRange(2, 1, n, H_GASTOS.length).getValues();
  const salida = [];
  filas.forEach(function (f, i) {
    if (f[0] === '' && f[1] === '' && f[2] === '') return; // fila vacía
    let id = String(f[7] || '');
    if (!id) { id = nuevoId(); h.getRange(i + 2, 8).setValue(id); } // filas antiguas o escritas a mano
    const categoria = String(f[4] || '');
    salida.push({
      id: id,
      fecha: f[0] instanceof Date ? Utilities.formatDate(f[0], zona, F_FECHA) : String(f[0] || ''),
      comercio: String(f[1] || ''),
      importe: typeof f[2] === 'number' ? f[2] : (leerImporte(f[2]) || 0),
      tarjeta: String(f[3] || ''),
      categoria: tipoValido(f[9]) !== 'gasto' ? '' : (!categoria || categoria === 'Sin categoría' ? CATEGORIA_POR_DEFECTO : categoria),
      origen: String(f[5] || ''),
      cuenta: String(f[8] || ''),
      tipo: tipoValido(f[9]),
      destino: String(f[10] || ''),
    });
  });
  return salida;
}

// Alta o cambio desde la app: { id?, fecha, comercio, importe, categoria, cuenta, tipo?, destino?, tarjeta?, origen? }
function guardarGasto(g) {
  if (!g) throw new Error('Falta el gasto');
  const h = hoja('Gastos', H_GASTOS);
  const id = String(g.id || nuevoId());
  let fecha = new Date();
  if (g.fecha) {
    const t = String(g.fecha);
    fecha = Utilities.parseDate(t.length === 16 ? t + ':00' : t.slice(0, 19), zonaHoraria(), F_FECHA);
  }
  const importe = typeof g.importe === 'number' ? g.importe : leerImporte(g.importe);
  const tipo = tipoValido(g.tipo);
  const categoria = tipo === 'gasto' ? (g.categoria || CATEGORIA_POR_DEFECTO) : '';
  const valores = [fecha, texto(g.comercio), importe, texto(g.tarjeta), texto(categoria), texto(g.origen || 'A mano')];
  const cola = [texto(g.cuenta), tipo, tipo === 'traspaso' ? texto(g.destino) : ''];
  const fila = buscarFila(h, 8, id);
  if (fila) {
    h.getRange(fila, 1, 1, 6).setValues([valores]);
    h.getRange(fila, 9, 1, 3).setValues([cola]);
  } else {
    h.appendRow(valores.concat(['', id], cola));
  }
  return { ok: true, id: id };
}

/* ------------------------------------------------------------- presupuestos */

function leerPresupuestos() {
  return leerFilas('Presupuestos', H_PRESUPUESTOS).map(function (f) {
    return { id: String(f[0]), nombre: String(f[1] || ''), limite: Number(f[2]) || 0, orden: Number(f[3]) || 0 };
  });
}

function guardarPresupuesto(p) {
  if (!p || !p.id) throw new Error('Falta el presupuesto');
  return guardarFila('Presupuestos', H_PRESUPUESTOS, String(p.id),
    [String(p.id), texto(p.nombre), Number(p.limite) || 0, Number(p.orden) || 0]);
}

/* ------------------------------------------------------------------ cuentas */

function leerCuentas() {
  const zona = zonaHoraria();
  return leerFilas('Cuentas', H_CUENTAS).map(function (f) {
    return {
      id: String(f[0]),
      nombre: String(f[1] || ''),
      saldo: typeof f[2] === 'number' ? f[2] : null,
      fechaSaldo: f[3] instanceof Date ? Utilities.formatDate(f[3], zona, F_FECHA) : String(f[3] || ''),
      tarjetas: String(f[4] || '').split(',').map(function (t) { return t.trim(); }).filter(String),
      orden: Number(f[5]) || 0,
      terminaEn: cuatroCifras(f[6]),
    };
  });
}

function guardarCuenta(c) {
  if (!c || !c.id) throw new Error('Falta la cuenta');
  const tarjetas = (c.tarjetas || []).map(function (t) { return String(t).replace(/,/g, ' ').trim(); }).filter(String);
  let terminaEn = c.terminaEn;
  if (terminaEn === undefined) {   // quien guarda no lo conoce: se conserva el que hubiera
    const h = hoja('Cuentas', H_CUENTAS);
    const fila = buscarFila(h, 1, String(c.id));
    terminaEn = fila ? h.getRange(fila, 7).getValue() : '';
  }
  return guardarFila('Cuentas', H_CUENTAS, String(c.id), [
    String(c.id),
    texto(c.nombre),
    typeof c.saldo === 'number' ? c.saldo : '',
    String(c.fechaSaldo || ''),
    texto(tarjetas.join(', ')),
    Number(c.orden) || 0,
    cuatroCifras(terminaEn),
  ]);
}

/* --------------------------------------------------------- avisos del banco */

// Se ejecuta sola cada pocos minutos (disparador) y también cada vez que la app pide los datos.
function tareaCorreo() {
  const candado = LockService.getScriptLock();
  try {
    candado.waitLock(20000);
    sincronizarCorreo();
  } finally {
    try { candado.releaseLock(); } catch (err) { /* no lo teníamos */ }
  }
}

// Si el correo falla (por ejemplo, falta el permiso), la app y el webhook siguen funcionando.
function sincronizarSinRomper() {
  try {
    asegurarDisparador();
    return sincronizarCorreo();
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

function asegurarDisparador() {
  const hay = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'tareaCorreo'; });
  if (!hay) ScriptApp.newTrigger('tareaCorreo').timeBased().everyMinutes(5).create();
}

function sincronizarCorreo() {
  const props = PropertiesService.getScriptProperties();
  let hechos = [];
  try { hechos = JSON.parse(props.getProperty('correoHechos') || '[]'); } catch (err) { hechos = []; }
  const ahora = Date.now();
  let aplicados = 0, nuevos = 0;
  AVISOS.forEach(function (aviso) {
    const lista = Gmail.Users.Messages.list('me', { q: 'from:' + aviso.remitente + ' newer_than:3d', maxResults: 50 });
    const pendientes = (lista.messages || [])
      .filter(function (m) { return hechos.indexOf(m.id) < 0; })
      .map(function (m) {
        const completo = Gmail.Users.Messages.get('me', m.id, { format: 'full' });
        return { id: m.id, t: Number(completo.internalDate), texto: textoDelCorreo(completo) };
      })
      .sort(function (a, b) { return a.t - b.t; });
    for (let i = 0; i < pendientes.length; i++) {
      const m = pendientes[i];
      if (ahora - m.t < AVISO_ESPERA_S * 1000) break;   // demasiado reciente: se verá en la siguiente pasada
      nuevos++;
      if (aplicarAviso(aviso, m)) aplicados++;
      hechos.push(m.id);
    }
  });
  props.setProperty('correoHechos', JSON.stringify(hechos.slice(-150)));
  return { ok: true, nuevos: nuevos, aplicados: aplicados };
}

// Pone en la cuenta el saldo que dice el banco y apunta la diferencia con lo calculado.
function aplicarAviso(aviso, m) {
  const hallado = aviso.patron.exec(m.texto);
  if (!hallado) return false;
  const disponible = leerImporte(hallado[1]);
  if (typeof disponible !== 'number') return false;
  const cuentas = leerCuentas();
  const c = cuentas.filter(function (x) { return x.terminaEn && x.terminaEn === hallado[2]; })[0];
  if (!c) return false;
  const zona = zonaHoraria();
  const fAviso = Utilities.formatDate(new Date(m.t), zona, F_FECHA);
  const fCorte = Utilities.formatDate(new Date(m.t + AVISO_MARGEN_S * 1000), zona, F_FECHA);
  if (c.fechaSaldo && fCorte <= conSegundos(c.fechaSaldo)) return false;   // el saldo anotado ya es posterior a este aviso
  if (typeof c.saldo === 'number') {
    const calculado = saldoCalculado(c, cuentas, leerGastos(), fCorte);
    const diferencia = Math.round((disponible - calculado) * 100) / 100;
    if (Math.abs(diferencia) >= 0.01) {
      const esGasto = diferencia < 0;
      hoja('Gastos', H_GASTOS).appendRow([
        new Date(m.t), SIN_IDENTIFICAR, Math.abs(diferencia), '', esGasto ? CATEGORIA_POR_DEFECTO : '',
        ORIGEN_BANCO, '', nuevoId(), c.id, esGasto ? 'gasto' : 'ingreso', '',
      ]);
    }
  }
  c.saldo = disponible;
  c.fechaSaldo = fCorte;
  guardarCuenta(c);
  return true;
}

// Saldo que le sale a la app para esa cuenta contando los movimientos apuntados hasta ese momento.
function saldoCalculado(c, cuentas, movimientos, hasta) {
  const desde = conSegundos(c.fechaSaldo);
  let neto = 0;
  movimientos.forEach(function (g) {
    const f = conSegundos(g.fecha);
    if (!(f > desde) || f > hasta) return;
    const importe = Number(g.importe) || 0;
    if (g.tipo === 'traspaso') {
      if (g.cuenta === c.id) neto -= importe;
      if (g.destino === c.id) neto += importe;
    } else if (cuentaDelMovimiento(g, cuentas) === c.id) {
      neto += g.tipo === 'ingreso' ? importe : -importe;
    }
  });
  return (Number(c.saldo) || 0) + neto;
}

// Misma regla que la app: la cuenta elegida a mano o, si no, la que tenga esa tarjeta.
function cuentaDelMovimiento(g, cuentas) {
  if (g.cuenta) return g.cuenta;
  const t = sinTildes(g.tarjeta);
  if (!t) return '';
  const orden = cuentas.slice().sort(function (a, b) { return (a.orden || 0) - (b.orden || 0) || String(a.nombre).localeCompare(String(b.nombre)); });
  const tiene = function (c, prueba) { return (c.tarjetas || []).some(function (a) { a = sinTildes(a); return a && prueba(a); }); };
  const exacta = orden.filter(function (c) { return tiene(c, function (a) { return a === t; }); })[0];
  if (exacta) return exacta.id;
  const parcial = orden.filter(function (c) { return tiene(c, function (a) { return t.indexOf(a) > -1; }); })[0];
  return parcial ? parcial.id : '';
}

// Texto legible del correo: prefiere la parte de texto plano y, si no hay, limpia el HTML.
function textoDelCorreo(mensaje) {
  const partes = { plano: '', html: '' };
  (function recorrer(p) {
    if (!p) return;
    if (p.body && p.body.data) {
      const t = Utilities.newBlob(Utilities.base64DecodeWebSafe(p.body.data)).getDataAsString('UTF-8');
      if (p.mimeType === 'text/plain') partes.plano += ' ' + t;
      else if (p.mimeType === 'text/html') partes.html += ' ' + t;
    }
    (p.parts || []).forEach(recorrer);
  })(mensaje.payload);
  const html = partes.html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&euro;/gi, '€').replace(/&#42;|&ast;/gi, '*').replace(/&[a-z#0-9]+;/gi, ' ');
  return [partes.plano, html, mensaje.snippet || ''].join(' ').replace(/\s+/g, ' ');
}

function conSegundos(fecha) {
  const f = String(fecha || '');
  return f.length === 16 ? f + ':00' : f;
}

function sinTildes(valor) {
  return String(valor == null ? '' : valor).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

function cuatroCifras(valor) {
  const d = String(valor == null ? '' : valor).replace(/\D/g, '');
  return d ? ('0000' + d).slice(-4) : '';
}

/* ------------------------------------------------------------------ lectura */

function leerTodo() {
  return { ok: true, gastos: leerGastos(), presupuestos: leerPresupuestos(), cuentas: leerCuentas() };
}

/* --------------------------------------------------------------- utilidades */

// Devuelve la hoja con ese nombre, creándola y poniéndole cabecera y formatos si hace falta.
function hoja(nombre, cabecera) {
  const libro = SpreadsheetApp.getActiveSpreadsheet();
  let h = libro.getSheetByName(nombre);
  const nueva = !h;
  if (nueva) h = libro.insertSheet(nombre);
  const actual = h.getLastRow() > 0 ? h.getRange(1, 1, 1, cabecera.length).getValues()[0] : [];
  if (cabecera.some(function (c, i) { return actual[i] !== c; })) {
    h.getRange(1, 1, 1, cabecera.length).setValues([cabecera]);
    h.setFrozenRows(1);
    if (nombre === 'Gastos') {
      h.getRange('A:A').setNumberFormat('dd/MM/yyyy HH:mm');
      h.getRange('C:C').setNumberFormat('#,##0.00 €');
      h.getRange('H:K').setNumberFormat('@');
    } else if (nombre === 'Presupuestos') {
      h.getRange('A:A').setNumberFormat('@');
      h.getRange('C:C').setNumberFormat('#,##0.00 €');
    } else if (nombre === 'Cuentas') {
      h.getRange('A:A').setNumberFormat('@');
      h.getRange('C:C').setNumberFormat('#,##0.00 €');
      h.getRange('D:E').setNumberFormat('@');
      h.getRange('G:G').setNumberFormat('@');
    }
  }
  return h;
}

function leerFilas(nombre, cabecera) {
  const h = hoja(nombre, cabecera);
  const n = h.getLastRow() - 1;
  if (n < 1) return [];
  return h.getRange(2, 1, n, cabecera.length).getValues().filter(function (f) { return String(f[0]) !== ''; });
}

// Fila (1 = cabecera) cuyo valor en la columna dada es ese id, o 0 si no existe.
function buscarFila(h, columna, id) {
  const n = h.getLastRow() - 1;
  if (n < 1) return 0;
  const valores = h.getRange(2, columna, n, 1).getValues();
  for (let i = 0; i < valores.length; i++) {
    if (String(valores[i][0]) === String(id)) return i + 2;
  }
  return 0;
}

function guardarFila(nombre, cabecera, id, valores) {
  const h = hoja(nombre, cabecera);
  const fila = buscarFila(h, 1, id);
  if (fila) h.getRange(fila, 1, 1, valores.length).setValues([valores]);
  else h.appendRow(valores);
  return { ok: true, id: id };
}

function borrarFila(nombre, cabecera, columna, id) {
  if (!id) throw new Error('Falta el identificador');
  const h = hoja(nombre, cabecera);
  const fila = buscarFila(h, columna, id);
  if (fila) h.deleteRow(fila);
  return { ok: true, id: String(id), borrado: !!fila };
}

function tipoValido(valor) {
  const t = String(valor || '').toLowerCase();
  return TIPOS.indexOf(t) > -1 ? t : 'gasto';
}

function zonaHoraria() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
}

function nuevoId() {
  return 'g' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

// Evita que un texto que empieza por = + - @ se guarde como fórmula en la hoja.
function texto(valor) {
  const t = String(valor == null ? '' : valor);
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}

/**
 * Convierte lo que envía Atajos en un número.
 * Acepta "12,50 €", "1.234,56 €", "€12.50", "12.5", 12.5 ...
 * Devuelve '' si no hay ningún número (así se ve el hueco en la hoja).
 */
function leerImporte(valor) {
  if (typeof valor === 'number') return valor;
  let t = String(valor).replace(/[^0-9.,-]/g, '');
  if (!/[0-9]/.test(t)) return '';

  const coma = t.lastIndexOf(',');
  const punto = t.lastIndexOf('.');

  if (coma > -1 && punto > -1) {
    // El separador que aparece más a la derecha es el decimal.
    if (coma > punto) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(/,/g, '');
  } else if (coma > -1) {
    t = t.replace(',', '.');
  } else if (punto > -1) {
    // "1.234" en formato español es mil doscientos treinta y cuatro.
    const partes = t.split('.');
    const esMiles = partes.length > 2 || (partes[1].length === 3 && partes[0].replace('-', '').length <= 3 && partes[0].replace('-', '') !== '0');
    if (esMiles) t = t.replace(/\./g, '');
  }

  const n = parseFloat(t);
  return isNaN(n) ? '' : n;
}

function categorizar(comercio) {
  const t = (' ' + comercio + ' ').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [categoria, palabras] of CATEGORIAS) {
    for (const palabra of palabras) {
      if (t.indexOf(palabra) > -1) return categoria;
    }
  }
  return CATEGORIA_POR_DEFECTO;
}

function responder(objeto) {
  return ContentService
    .createTextOutput(JSON.stringify(objeto))
    .setMimeType(ContentService.MimeType.JSON);
}

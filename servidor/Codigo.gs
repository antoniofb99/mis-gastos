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
const H_CUENTAS = ['ID', 'Nombre', 'Saldo', 'Fecha saldo', 'Tarjetas', 'Orden', 'Termina en', 'Rol', 'Objetivo', 'Aportado', 'Fecha aportado'];
const ROLES = ['gasto', 'ahorro', 'inversion', 'conjunta'];   // para qué es cada cuenta
// Una fila por día con el saldo de cada cuenta: de aquí sale la gráfica de evolución.
const H_SALDOS = ['Día', 'Total', 'Cuentas'];
const SALDOS_MAX = 800;   // días que se devuelven a la app
// Fondos de una cuenta de inversión: su valor es participaciones x precio. Las dos últimas columnas son para
// fórmulas de la propia hoja que lean el precio y su fecha de fuera; si dan un número, pasa a ser el precio.
const H_FONDOS = ['ISIN', 'Nombre', 'Cuenta', 'Participaciones', 'Fecha participaciones', 'Precio', 'Fecha precio', 'Lectura precio', 'Lectura fecha'];
const FONDO_DATOS = 7;    // columnas que escribe el script; las de lectura no se tocan
// Página pública de la que la hoja lee cada día el valor liquidativo (con IMPORTXML): se le añade el ISIN.
const FUENTE_PRECIO = 'https://www.finect.com/fondos-inversion/';
// Correos con los que el bróker confirma cada compra o venta de un fondo: de ahí salen las participaciones.
const OPERACIONES = { remitente: 'notificaciones@myinvestor.es', asunto: 'OPERACIÓN DE VALORES' };

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
        const operaciones = operacionesSinRomper();
        valorarSinRomper();
        fotoSinRomper();
        const todo = leerTodo();
        todo.correo = correo;
        todo.operaciones = operaciones;
        return responder(todo);
      }
      case 'gasto.guardar': return responder(guardarGasto(datos.gasto));
      case 'gasto.borrar': return responder(borrarFila('Gastos', H_GASTOS, 8, datos.id));
      case 'presupuesto.guardar': return responder(guardarPresupuesto(datos.presupuesto));
      case 'presupuesto.borrar': return responder(borrarFila('Presupuestos', H_PRESUPUESTOS, 1, datos.id));
      case 'cuenta.guardar': return responder(guardarCuenta(datos.cuenta));
      case 'cuenta.borrar': return responder(borrarFila('Cuentas', H_CUENTAS, 1, datos.id));
      case 'fondo.guardar': return responder(guardarFondo(datos.fondo));
      case 'fondo.borrar': return responder(borrarFondo(datos.id));
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
  // Sin comercio ni importe es una prueba de conexión (ejecutar el atajo a mano): se contesta sin apuntar nada.
  if (!comercio && !(importe > 0)) {
    return { ok: true, prueba: true, mensaje: 'Conexión correcta. No se ha apuntado nada porque no venía ni comercio ni importe.' };
  }
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
      fecha: fechaTexto(f[0], zona),
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
      fechaSaldo: fechaTexto(f[3], zona),
      tarjetas: String(f[4] || '').split(',').map(function (t) { return t.trim(); }).filter(String),
      orden: Number(f[5]) || 0,
      terminaEn: cuatroCifras(f[6]),
      rol: rolValido(f[7]),
      objetivo: typeof f[8] === 'number' ? f[8] : null,
      aportado: typeof f[9] === 'number' ? f[9] : null,
      fechaAportado: fechaTexto(f[10], zona),
    };
  });
}

function guardarCuenta(c) {
  if (!c || !c.id) throw new Error('Falta la cuenta');
  const tarjetas = (c.tarjetas || []).map(function (t) { return String(t).replace(/,/g, ' ').trim(); }).filter(String);
  // Lo que quien guarda no conoce (undefined) se conserva tal como estuviera en la hoja.
  const h = hoja('Cuentas', H_CUENTAS);
  const fila = buscarFila(h, 1, String(c.id));
  const antes = fila ? h.getRange(fila, 1, 1, H_CUENTAS.length).getValues()[0] : [];
  const o = function (valor, columna) { return valor === undefined ? (antes[columna] === undefined ? '' : antes[columna]) : valor; };
  const numero = function (valor) { return typeof valor === 'number' && isFinite(valor) ? valor : ''; };
  const zona = zonaHoraria();
  const fechaAportado = o(c.fechaAportado, 10);
  return guardarFila('Cuentas', H_CUENTAS, String(c.id), [
    String(c.id),
    texto(c.nombre),
    typeof c.saldo === 'number' ? c.saldo : '',
    c.fechaSaldo ? "'" + fechaTexto(c.fechaSaldo, zona) : '',
    texto(tarjetas.join(', ')),
    Number(c.orden) || 0,
    cuatroCifras(o(c.terminaEn, 6)),
    rolValido(o(c.rol, 7)),
    numero(o(c.objetivo, 8)),
    numero(o(c.aportado, 9)),
    fechaAportado ? "'" + fechaTexto(fechaAportado, zona) : '',
  ]);
}

function rolValido(valor) {
  const r = String(valor || '').toLowerCase();
  return ROLES.indexOf(r) > -1 ? r : '';
}

/* ------------------------------------------------------------------- fondos */

function leerFondos() {
  const zona = zonaHoraria();
  return leerFilas('Fondos', H_FONDOS).map(function (f) {
    return {
      id: String(f[0]),
      nombre: String(f[1] || ''),
      cuenta: String(f[2] || ''),
      participaciones: typeof f[3] === 'number' ? f[3] : null,
      fechaParticipaciones: fechaTexto(f[4], zona),
      precio: typeof f[5] === 'number' ? f[5] : null,
      fechaPrecio: diaTexto(f[6], zona),
    };
  });
}

function isinValido(valor) {
  const isin = String(valor || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin) ? isin : '';
}

function guardarFondo(x) {
  const isin = isinValido(x && x.id);
  if (!isin) throw new Error('ISIN no válido');
  const h = hoja('Fondos', H_FONDOS);
  const fila = buscarFila(h, 1, isin);
  const antes = fila ? h.getRange(fila, 1, 1, FONDO_DATOS).getValues()[0] : [];
  const o = function (valor, columna) { return valor === undefined ? (antes[columna] === undefined ? '' : antes[columna]) : valor; };
  const numero = function (valor) { return typeof valor === 'number' && isFinite(valor) && valor >= 0 ? valor : ''; };
  const zona = zonaHoraria();
  const fPart = o(x.fechaParticipaciones, 4), fPrecio = diaTexto(o(x.fechaPrecio, 6), zona);
  guardarFila('Fondos', H_FONDOS, isin, [
    isin,
    texto(o(x.nombre, 1)),
    texto(o(x.cuenta, 2)),
    numero(o(x.participaciones, 3)),
    fPart ? "'" + fechaTexto(fPart, zona) : '',
    numero(o(x.precio, 5)),
    fPrecio ? "'" + fPrecio : '',
  ]);
  valorarFondos();
  return { ok: true, id: isin };
}

function borrarFondo(id) {
  const r = borrarFila('Fondos', H_FONDOS, 1, isinValido(id) || id);
  valorarFondos();
  return r;
}

// Pasa a "Precio" lo que hayan leído las fórmulas y pone en cada cuenta el valor de sus fondos.
// La fecha del saldo es la de las participaciones: lo traspasado después se suma hasta que se actualicen.
function valorarFondos() {
  const h = hoja('Fondos', H_FONDOS);
  const n = h.getLastRow() - 1;
  if (n < 1) return 0;
  const zona = zonaHoraria();
  const hoy = Utilities.formatDate(new Date(), zona, 'yyyy-MM-dd');
  const filas = h.getRange(2, 1, n, H_FONDOS.length).getValues().filter(function (f) { return String(f[0]) !== ''; });
  const vacias = filas.filter(function (f) { return f[7] === '' || f[7] == null; }).map(function (f) { return String(f[0]); });
  filas.forEach(function (f) {
    const leido = f[7];
    if (typeof leido !== 'number' || !isFinite(leido) || !(leido > 0)) return;
    if (typeof f[5] === 'number' && f[5] > 0 && (leido / f[5] > 2 || leido / f[5] < 0.5)) return;   // un salto así es un error de lectura, no un precio
    const fecha = diaTexto(f[8], zona) || hoy;
    if (leido === f[5] && fecha === diaTexto(f[6], zona)) return;
    f[5] = leido; f[6] = fecha;
    h.getRange(buscarFila(h, 1, String(f[0])), 6, 1, 2).setValues([[leido, "'" + fecha]]);
  });
  const porCuenta = {};
  filas.forEach(function (f) { const c = String(f[2] || ''); if (c) (porCuenta[c] = porCuenta[c] || []).push(f); });
  const cuentas = leerCuentas();
  let cambiadas = 0;
  Object.keys(porCuenta).forEach(function (id) {
    const c = cuentas.filter(function (q) { return q.id === id; })[0];
    const fondos = porCuenta[id];
    if (!c || !fondos.every(function (f) { return typeof f[3] === 'number' && typeof f[5] === 'number'; })) return;
    const valor = Math.round(fondos.reduce(function (a, f) { return a + f[3] * f[5]; }, 0) * 100) / 100;
    const fecha = fondos.map(function (f) { return conSegundos(fechaTexto(f[4], zona)); }).sort().pop() || c.fechaSaldo || Utilities.formatDate(new Date(), zona, F_FECHA);
    if (c.saldo === valor && conSegundos(c.fechaSaldo) === fecha) return;
    c.saldo = valor; c.fechaSaldo = fecha;
    guardarCuenta(c);
    cambiadas++;
  });
  ponerLecturas(h, vacias, hoy);
  return cambiadas;
}

// Fórmulas que leen el precio y su fecha de la página del fondo. Se reescriben una vez al día
// (con el día en la dirección, para que la hoja vuelva a pedir la página) y en los fondos que aún no las tienen.
function ponerLecturas(h, vacias, hoy) {
  const props = PropertiesService.getScriptProperties();
  const todas = props.getProperty('lecturaDia') !== hoy;
  const n = h.getLastRow() - 1;
  if (n < 1 || (!todas && !vacias.length)) return;
  const ingles = /^(en|ja|zh|ko|th|he|hi)/i.test(String(SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetLocale() || ''));
  const sep = ingles ? ',' : ';';
  const isines = h.getRange(2, 1, n, 1).getValues();
  for (let i = 0; i < isines.length; i++) {
    const isin = isinValido(isines[i][0]);
    if (!isin || (!todas && vacias.indexOf(isin) < 0)) continue;
    const url = FUENTE_PRECIO + isin + '-x?d=' + hoy.replace(/-/g, '');
    const crudo = 'REGEXEXTRACT(INDEX(IMPORTXML("' + url + '"' + sep + '"//script[@type=\'application/ld+json\'][contains(.,\'offers\')]")' + sep + '1)' + sep + '"""price"":""?([0-9.]+)")';
    const precio = ingles ? '=VALUE(' + crudo + ')' : '=VALUE(SUBSTITUTE(' + crudo + sep + '"."' + sep + '","))';
    const fecha = '=TEXTJOIN(" "' + sep + 'TRUE' + sep + 'IMPORTXML("' + url + '"' + sep + '"(//*[contains(.,\'Fecha de valor liquidativo\')])[last()]"))';
    h.getRange(i + 2, 8).setFormula(precio);
    h.getRange(i + 2, 9).setFormula(fecha);
  }
  if (todas) props.setProperty('lecturaDia', hoy);
}

/* ------------------------------------------- compras y ventas confirmadas por correo */

// Saca de un correo de confirmación el fondo, las participaciones, el precio y el importe. null si no encaja.
function leerOperacion(texto, asunto) {
  const t = String(texto || '').replace(/\s+/g, ' ');
  const isin = (/ISIN:\s*([A-Z]{2}[A-Z0-9]{9}\d)/.exec(t) || [])[1];
  const tipo = (/(SUSCRIPCION|REEMBOLSO)[^0-9]{0,40}?I\.I\.C\./.exec(t) || [])[0];
  const n = /Importe Bruto\s+([\d.,]+)\s+([\d.,]+)\s*EUR\s+([\d.,]+)\s*EUR/.exec(t);
  const f = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2})\/(\d{2})\/(\d{4})/.exec(t);
  if (!isin || !tipo || !n || !f) return null;
  const num = function (x) { return Number(String(x).replace(/,/g, '')); };   // vienen como 2,500.00
  const titulos = num(n[1]), precio = num(n[2]), importe = num(n[3]);
  if (!(titulos > 0) || !(precio > 0) || !isFinite(importe)) return null;
  return {
    isin: isin,
    signo: /^REEMBOLSO/.test(tipo) ? -1 : 1,
    traspaso: /TRASPASO/.test(tipo),          // cambio de un fondo a otro: no es dinero nuevo
    titulos: titulos, precio: precio, importe: importe,
    diaOperacion: f[3] + '-' + f[2] + '-' + f[1],
    diaValor: f[6] + '-' + f[5] + '-' + f[4],
    nombre: String(String(asunto || '').split('#')[3] || '').trim(),
  };
}

// Aplica una operación: suma o resta participaciones, apunta el precio si es más reciente y suma lo aportado.
// Las participaciones solo se tocan si la operación es posterior al día en que se anotaron (lo anterior ya está contado).
function aplicarOperacion(op, t) {
  const zona = zonaHoraria();
  const cuando = Utilities.formatDate(new Date(t), zona, F_FECHA);
  const f = leerFondos().filter(function (x) { return x.id === op.isin; })[0];
  const deInversion = leerCuentas().filter(function (c) { return c.rol === 'inversion'; }).sort(function (a, b) { return (a.orden || 0) - (b.orden || 0); })[0];
  const cuentaId = f && f.cuenta ? f.cuenta : (deInversion ? deInversion.id : '');
  if (!cuentaId) return false;
  const cambio = { id: op.isin };
  if (!f) {
    cambio.nombre = op.nombre || op.isin; cambio.cuenta = cuentaId;
    cambio.participaciones = Math.max(0, op.signo * op.titulos); cambio.fechaParticipaciones = cuando;
  } else if (op.diaOperacion > String(f.fechaParticipaciones || '').slice(0, 10)) {
    cambio.participaciones = Math.max(0, Math.round(((f.participaciones || 0) + op.signo * op.titulos) * 1e7) / 1e7);
    cambio.fechaParticipaciones = cuando;
  }
  if (!f || !f.fechaPrecio || op.diaValor > f.fechaPrecio) { cambio.precio = op.precio; cambio.fechaPrecio = op.diaValor; }
  guardarFondo(cambio);
  if (!op.traspaso) {
    const c = leerCuentas().filter(function (x) { return x.id === cuentaId; })[0];
    if (c && typeof c.aportado === 'number') {
      c.aportado = Math.round((c.aportado + op.signo * op.importe) * 100) / 100;
      c.fechaAportado = cuando;
      guardarCuenta(c);
    }
  }
  return true;
}

// Mira los correos de confirmación de los últimos días y aplica los que no se hayan visto todavía.
// La primera vez no aplica nada: da por contado lo que ya hay en el buzón.
function sincronizarOperaciones() {
  const props = PropertiesService.getScriptProperties();
  const cruda = props.getProperty('operacionesHechas');
  let hechas = [];
  try { hechas = JSON.parse(cruda || '[]'); } catch (err) { hechas = []; }
  const lista = Gmail.Users.Messages.list('me', { q: 'from:' + OPERACIONES.remitente + ' subject:"' + OPERACIONES.asunto + '" newer_than:30d', maxResults: 50 });
  const ids = (lista.messages || []).map(function (m) { return m.id; });
  if (cruda === null) {
    props.setProperty('operacionesHechas', JSON.stringify(ids));
    return { ok: true, nuevas: 0, aplicadas: 0, inicio: true };
  }
  const nuevos = ids.filter(function (id) { return hechas.indexOf(id) < 0; }).map(function (id) {
    const c = Gmail.Users.Messages.get('me', id, { format: 'full' });
    const cab = ((c.payload && c.payload.headers) || []).filter(function (h) { return /^subject$/i.test(h.name); })[0];
    return { id: id, t: Number(c.internalDate), texto: textoDelCorreo(c), asunto: cab ? cab.value : '' };
  }).sort(function (a, b) { return a.t - b.t; });
  let aplicadas = 0;
  nuevos.forEach(function (m) {
    const op = leerOperacion(m.texto, m.asunto);
    if (op && aplicarOperacion(op, m.t)) aplicadas++;
    hechas.push(m.id);
  });
  if (nuevos.length) props.setProperty('operacionesHechas', JSON.stringify(hechas.slice(-300)));
  return { ok: true, nuevas: nuevos.length, aplicadas: aplicadas };
}

function operacionesSinRomper() {
  try { return sincronizarOperaciones(); } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
}

// Si la valoración falla, lo demás sigue funcionando.
function valorarSinRomper() {
  try { return valorarFondos(); } catch (err) { return 0; }
}

// Día "aaaa-mm-dd" a partir de una fecha de la hoja, un texto ISO o un texto "d/m/aaaa".
function diaTexto(valor, zona) {
  if (valor instanceof Date) return Utilities.formatDate(valor, zona || zonaHoraria(), 'yyyy-MM-dd');
  const t = String(valor == null ? '' : valor).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return '';
}

/* ------------------------------------------------------- historial de saldos */

// Una vez al día (la primera pasada tras medianoche) apunta el saldo de cada cuenta.
function fotoDiaria() {
  const zona = zonaHoraria();
  const hoy = Utilities.formatDate(new Date(), zona, 'yyyy-MM-dd');
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('fotoDia') === hoy) return false;
  const cuentas = leerCuentas();
  const conSaldo = cuentas.filter(function (c) { return typeof c.saldo === 'number'; });
  if (!conSaldo.length) return false;   // aún no hay nada que apuntar: se volverá a mirar en la siguiente pasada
  {
    const movimientos = leerGastos();
    const ahora = Utilities.formatDate(new Date(), zona, F_FECHA);
    const detalle = {};
    let total = 0;
    conSaldo.forEach(function (c) {
      const v = Math.round(saldoCalculado(c, cuentas, movimientos, ahora) * 100) / 100;
      detalle[c.id] = v; total += v;
    });
    guardarFila('Saldos', H_SALDOS, hoy, ["'" + hoy, Math.round(total * 100) / 100, JSON.stringify(detalle)]);
  }
  props.setProperty('fotoDia', hoy);
  return true;
}

// Si la foto falla, lo demás sigue funcionando.
function fotoSinRomper() {
  try { return fotoDiaria(); } catch (err) { return false; }
}

function leerSaldos() {
  const zona = zonaHoraria();
  return leerFilas('Saldos', H_SALDOS).slice(-SALDOS_MAX).map(function (f) {
    let cuentas = {};
    try { cuentas = JSON.parse(String(f[2] || '{}')) || {}; } catch (err) { cuentas = {}; }
    const dia = f[0] instanceof Date ? Utilities.formatDate(f[0], zona, 'yyyy-MM-dd') : String(f[0]).slice(0, 10);
    return { dia: dia, total: Number(f[1]) || 0, cuentas: cuentas };
  });
}

/* --------------------------------------------------------- avisos del banco */

// Para ejecutar UNA vez a mano desde el editor: Google pide entonces los permisos que faltan
// (leer Gmail y ejecutarse sola) y, ya con ellos, hace la primera lectura de avisos.
function autorizar() {
  asegurarDisparador();
  Gmail.Users.getProfile('me');
  const candado = LockService.getScriptLock();
  try {
    candado.waitLock(20000);
    const resultado = sincronizarCorreo();
    console.log('Avisos leídos: ' + JSON.stringify(resultado));
    return resultado;
  } finally {
    try { candado.releaseLock(); } catch (err) { /* no lo teníamos */ }
  }
}

// Se ejecuta sola cada pocos minutos (disparador) y también cada vez que la app pide los datos.
function tareaCorreo() {
  const candado = LockService.getScriptLock();
  try {
    candado.waitLock(20000);
    try { sincronizarCorreo(); } finally { operacionesSinRomper(); valorarSinRomper(); fotoSinRomper(); }
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
      let t = '';
      try {
        // Apps Script suele entregar el cuerpo ya como bytes; si llega en base64, se decodifica.
        const d = p.body.data;
        t = Utilities.newBlob(typeof d === 'string' ? Utilities.base64DecodeWebSafe(d) : d).getDataAsString('UTF-8');
      } catch (err) { t = ''; }   // si una parte no se puede leer, queda el resumen del mensaje
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

// Fecha y hora siempre como "AAAA-MM-DDTHH:mm:ss", venga de la hoja como fecha o como texto
// (la hoja a veces convierte el texto en fecha, o lo muestra con un espacio en lugar de la T).
function fechaTexto(valor, zona) {
  if (valor instanceof Date) return Utilities.formatDate(valor, zona, F_FECHA);
  const t = String(valor == null ? '' : valor).trim();
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?/.exec(t);
  return m ? m[1] + 'T' + m[2] + (m[3] || ':00') : t;
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
  return { ok: true, gastos: leerGastos(), presupuestos: leerPresupuestos(), cuentas: leerCuentas(), saldos: leerSaldos(), fondos: leerFondos() };
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
      h.getRange('G:H').setNumberFormat('@');
      h.getRange('I:J').setNumberFormat('#,##0.00 €');
      h.getRange('K:K').setNumberFormat('@');
    } else if (nombre === 'Fondos') {
      h.getRange('A:C').setNumberFormat('@');
      h.getRange('E:E').setNumberFormat('@');
      h.getRange('G:G').setNumberFormat('@');
    } else if (nombre === 'Saldos') {
      h.getRange('A:A').setNumberFormat('@');
      h.getRange('B:B').setNumberFormat('#,##0.00 €');
      h.getRange('C:C').setNumberFormat('@');
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

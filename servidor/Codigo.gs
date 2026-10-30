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
const ROLES = ['gasto', 'ahorro', 'inversion', 'conjunta', 'afe'];   // para qué es cada cuenta
// Una fila por día con el saldo de cada cuenta: de aquí sale la gráfica de evolución.
const H_SALDOS = ['Día', 'Total', 'Cuentas'];
const SALDOS_MAX = 800;   // días que se devuelven a la app
// Fondos de una cuenta de inversión: su valor es participaciones x precio. Las dos últimas columnas son para
// fórmulas de la propia hoja que lean el precio y su fecha de fuera; si dan un número, pasa a ser el precio.
const H_FONDOS = ['ISIN', 'Nombre', 'Cuenta', 'Participaciones', 'Fecha participaciones', 'Precio', 'Fecha precio', 'Lectura precio', 'Lectura fecha', 'Lectura'];
const FONDO_DATOS = 7;    // columnas que escribe el script; las de lectura no se tocan
// Página pública de la que la hoja lee cada día el valor liquidativo (con IMPORTXML): se le añade el ISIN.
// La columna "Lectura" trae el trozo de página en una sola petición; "Lectura precio" y "Lectura fecha" lo trocean.
const FUENTE_PRECIO = 'https://www.finect.com/fondos-inversion/';
// Criptomonedas: van en la misma hoja con su símbolo (BTC, ETH…) en lugar de ISIN. Su precio en euros sale de
// Google Finance y, si no la tiene, de CoinGecko, que la conoce por este nombre (si no está aquí, por el símbolo en minúsculas).
const CRIPTO_PRECIO = 'https://api.coingecko.com/api/v3/simple/price?vs_currencies=eur&ids=';
const COINGECKO = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', ADA: 'cardano', XRP: 'ripple', DOGE: 'dogecoin', DOT: 'polkadot',
  BNB: 'binancecoin', USDT: 'tether', USDC: 'usd-coin', LTC: 'litecoin', BCH: 'bitcoin-cash', AVAX: 'avalanche-2', POL: 'polygon-ecosystem-token',
  MATIC: 'matic-network', LINK: 'chainlink', TRX: 'tron', SHIB: 'shiba-inu', PEPE: 'pepe', XLM: 'stellar', ATOM: 'cosmos', NEAR: 'near',
  SUI: 'sui', TON: 'the-open-network', UNI: 'uniswap', ALGO: 'algorand', HBAR: 'hedera-hashgraph', ICP: 'internet-computer', APT: 'aptos',
  ARB: 'arbitrum', OP: 'optimism', FET: 'fetch-ai', RENDER: 'render-token', INJ: 'injective-protocol', XMR: 'monero',
  ETC: 'ethereum-classic', VET: 'vechain', FIL: 'filecoin', AAVE: 'aave', CRO: 'crypto-com-chain', SAND: 'the-sandbox',
  MANA: 'decentraland', TRUMP: 'official-trump', WIF: 'dogwifcoin', BONK: 'bonk', KAS: 'kaspa', SEI: 'sei-network', TAO: 'bittensor' };
// Correos con los que el bróker confirma cada compra o venta de un fondo: de ahí salen las participaciones.
const OPERACIONES = { remitente: 'notificaciones@myinvestor.es', asunto: 'OPERACIÓN DE VALORES' };

// Avisos de saldo por correo. El texto es del tipo:
// "te informamos de que tienes disponible 143,00 EUR en tu cuenta terminada en **0061."
const AVISOS = [{
  banco: 'Santander',
  remitente: 'SantanderInforma@emailing.bancosantander-mail.es',
  patron: /disponible\s+(?:de\s+)?([\d.,]+)\s*(?:EUR|€)\s+en\s+tu\s+cuenta\s+terminada\s+en\s+[*\s]*(\d{4})/i,
  // Correos de cada movimiento, con su nombre: así no quedan «sin identificar».
  // "te informamos de que CAPPUCCINO SEVI ha realizado una retención de 4.95 EUR en tu tarjeta terminada en 5418."
  // "te confirmamos que has pagado 62.26 EUR con tu tarjeta terminada en 5418 en REPSOL WAYLET."
  // "te informamos de que el 2026-11-02 se cargará el recibo de 64.88 EUR emitido por ASISA, ASISTENCIA SANITARIA en tu cuenta terminada en **0061."
  movimientos: [
    { tipo: 'gasto', patron: /informamos\s+de\s+que\s+(.+?)\s+ha\s+realizado\s+una\s+retenci[oó]n\s+de\s+([\d.,]+)\s*(?:EUR|€)\s+en\s+tu\s+tarjeta\s+terminada\s+en\s+[*\s]*(\d{4})/i, comercio: 1, importe: 2, fin: 3 },
    { tipo: 'gasto', patron: /has\s+pagado\s+([\d.,]+)\s*(?:EUR|€)\s+con\s+tu\s+tarjeta\s+terminada\s+en\s+[*\s]*(\d{4})\s+en\s+(.+?)\.\s+(?:Consulta|Para|Gracias)/i, comercio: 3, importe: 1, fin: 2 },
    // "te informamos de que se ha realizado un movimiento de 1.423,36 EUR en tu cuenta acabada en 0061." (no dice el signo:
    // el Santander solo manda este aviso para lo que entra; lo grande se toma por la nómina, que abre el mes)
    { tipo: 'ingreso', patron: /se\s+ha\s+realizado\s+un\s+movimiento\s+de\s+([\d.,]+)\s*(?:EUR|€)\s+en\s+tu\s+cuenta\s+acabada\s+en\s+[*\s]*(\d{4})/i, importe: 1, fin: 2,
      nombre: function (importe) { return importe >= NOMINA_MINIMA ? 'Nómina' : 'Transferencia recibida'; } },
    // "te confirmamos que tu transferencia de 250,00 EUR desde la cuenta acabada en 0061 se ha enviado correctamente."
    // Si es justo lo que pones cada mes en la cuenta conjunta (su presupuesto), es esa aportación; si no, una transferencia enviada.
    { tipo: 'gasto', transferencia: true, patron: /tu\s+transferencia\s+de\s+([\d.,]+)\s*(?:EUR|€)\s+desde\s+la\s+cuenta\s+acabada\s+en\s+[*\s]*(\d{4})\s+se\s+ha\s+enviado/i, importe: 1, fin: 2,
      nombre: function () { return 'Transferencia enviada'; } },
    { tipo: 'gasto', recibo: true, patron: /el\s+(\d{4}-\d{2}-\d{2})\s+se\s+cargar[aá]\s+el\s+recibo\s+de\s+([\d.,]+)\s*(?:EUR|€)\s+emitido\s+por\s+(.+?)\s+en\s+tu\s+cuenta\s+terminada\s+en\s+[*\s]*(\d{4})/i, dia: 1, importe: 2, comercio: 3, fin: 4 },
  ],
}];
// MyInvestor avisa de cada transferencia que le haces, con la cuenta de origen: así se sabe que es una aportación.
// "TRANSFERENCIA INMEDIATA … Importe Bruto Cuenta 496.26 EUR XXXX-XXXX-XX-XXXXXX0061 …"
AVISOS.push({
  banco: 'MyInvestor',
  remitente: 'notificaciones@myinvestor.es',
  patron: /(?!)/,   // no manda avisos de saldo
  movimientos: [
    { tipo: 'traspaso', aportacion: true, patron: /TRANSFERENCIA\s+INMEDIATA[\s\S]*?Importe\s+Bruto\s+Cuenta\s+([\d.,]+)\s*EUR\s+[X*\-\s]+(\d{4})\b/i, importe: 1, fin: 2,
      nombre: function () { return 'Aportación a MyInvestor'; } },
  ],
});
const MOV_APPLE_PAY_MIN = 15;   // un pago con tarjeta que ya llegó por Apple Pay en este margen no se apunta otra vez
const NOMINA_MINIMA = 500;   // un ingreso avisado por correo desde esta cantidad se toma por la nómina
const MOV_MISMO_DIAS = 3;      // el mismo pago (mismo importe y comercio parecido) avisado otra vez en estos días: no se repite
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
  ['Suscripciones', ['claude', 'anthropic', 'whoop', 'icloud', 'apple.com']],
  ['Supermercado', ['mercadona', 'lidl', 'carrefour', 'aldi', ' dia ', 'alcampo', 'eroski', 'consum', 'supersol', 'coviran', 'masymas', ' mas ', 'family cash', 'euro cash', 'eurocash']],
  ['Gasolina', ['repsol', 'cepsa', 'moeve', ' bp ', 'shell', 'galp', 'petroprix', 'plenoil', 'plenergy', 'ballenoil', 'waylet', 'gasolinera', 'e.s.', 'eess', 'estacion de servicio']],
  ['Restaurantes', ['restaurante', ' rest ', ' bar ', 'cafeteria', ' cafe ', 'cappuccino', 'burger', 'kebab', 'doner', 'pizz', 'taberna', 'helad', 'rodilla', 'mcdonald', 'kfc', 'telepizza', 'domino', 'glovo', 'just eat', 'uber eats', 'cerveceria', 'meson', ' venta ']],
  ['Coche', ['seguro coche', 'mapfre', 'mutua madrilena', 'linea directa', ' itv', 'taller', 'neumatic', 'norauto', 'midas', 'feu vert']],
  ['Transporte', ['renfe', 'uber', 'cabify', 'bolt', 'taxi', 'parking', 'aparcamiento', 'peaje', 'autopista', 'alsa']],
  ['Compras', ['amazon', 'zara', 'decathlon', 'el corte ingles', 'ikea', 'leroy', 'mediamarkt', 'media markt', 'primark', 'primor', 'joyeria', 'aliexpress']],
  ['Salud', ['farmacia', 'clinica', 'fisio', 'dental', 'optica', 'nutricion', 'asisa', 'sanitas', 'adeslas', ' dkv']],
  ['Ocio', [' cine', 'cines', 'spotify', 'netflix', 'hbo', 'disney', 'steam', 'playstation', 'ticketmaster', 'loter', 'discoteca']],
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

  const accion = datos.accion || 'pago';
  const candado = LockService.getScriptLock();
  try {
    // Un pago de Apple Pay no espera a que acabe otra cosa (p. ej. la app leyendo el correo, que tarda):
    // si el atajo se queda esperando, iOS lo corta y el pago se pierde. Apuntar una fila no necesita el candado.
    if (accion === 'pago' || accion === 'pagos' || accion === 'notificacion') candado.tryLock(2000); else candado.waitLock(20000);
    switch (accion) {
      case 'pago': return responder(apuntarPago(datos));
      // Varios pagos de golpe (los que el atajo no pudo enviar antes). Cada uno lleva su id y no se apunta dos veces.
      // Notificación de una app del banco que manda un atajo de iOS (Trade Republic, Santander, Revolut…).
      case 'notificacion': return responder(apuntarNotificacion(datos));
      case 'pagos': return responder({ ok: true, pagos: (datos.pagos || []).map(function (p) { return apuntarPago(Object.assign({}, p, { clave: undefined })); }) });
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
      case 'correo.repasar': return responder(repasarCorreo(Math.min(30, Number(datos.dias) || 10)));
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
  const h = hoja('Gastos', H_GASTOS);
  // Con id propio (lo pone el atajo), el mismo pago enviado dos veces se apunta una sola.
  const idPropio = String(datos.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  if (idPropio && buscarFila(h, 8, idPropio)) return { ok: true, id: idPropio, comercio: comercio, importe: importe, repetido: true, mensaje: 'Ese pago ya estaba apuntado.' };
  // Mismo comercio e importe en menos de un minuto: es el mismo pago repetido (p. ej. una tarjeta
  // rechazada y luego otra). Se queda el último: en esa fila se ponen la fecha y la tarjeta nuevas.
  const repetida = pagoRepetido(h, comercio, importe, new Date());
  if (repetida) {
    h.getRange(repetida.fila, 1).setValue(new Date());
    h.getRange(repetida.fila, 4).setValue(texto(String(datos.tarjeta || '').trim()));
    return { ok: true, id: repetida.id, comercio: comercio, importe: importe, repetido: true,
      mensaje: 'Pago repetido en menos de un minuto: se ha quedado solo el último.' };
  }
  const id = idPropio || nuevoId();
  h.appendRow([
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

const REPETIDO_MS = 60 * 1000;
// Busca entre las últimas filas un pago de Apple Pay igual (comercio e importe) de hace menos de un minuto.
// Solo cuentan los que siguen como llegaron: sin cuenta puesta a mano y de tipo gasto.
function pagoRepetido(h, comercio, importe, ahora) {
  const ultima = h.getLastRow();
  if (ultima < 2 || !(importe > 0)) return null;
  const desde = Math.max(2, ultima - 19);
  const filas = h.getRange(desde, 1, ultima - desde + 1, H_GASTOS.length).getValues();
  const igual = function (a) { return String(a || '').trim().toLowerCase() === comercio.toLowerCase(); };
  for (let i = filas.length - 1; i >= 0; i--) {
    const f = filas[i];
    if (!(f[0] instanceof Date)) continue;
    const dif = ahora.getTime() - f[0].getTime();
    if (dif < 0 || dif > REPETIDO_MS) continue;
    const imp = typeof f[2] === 'number' ? f[2] : leerImporte(f[2]);
    if (!igual(f[1]) || Math.abs(imp - importe) > 0.004) continue;
    if (String(f[8] || '') || tipoValido(f[9]) !== 'gasto' || String(f[5] || '') === 'A mano') continue;
    return { fila: desde + i, id: String(f[7] || '') };
  }
  return null;
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
      // Un ingreso con categoría es una devolución de ese gasto (p. ej. el Bizum de quien te debía su parte).
      categoria: tipoValido(f[9]) === 'traspaso' ? '' : tipoValido(f[9]) === 'ingreso' ? categoria : (!categoria || categoria === 'Sin categoría' ? CATEGORIA_POR_DEFECTO : categoria),
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
  const categoria = tipo === 'gasto' ? (g.categoria || CATEGORIA_POR_DEFECTO) : tipo === 'ingreso' ? (g.categoria || '') : '';
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

function criptoValida(valor) {
  const s = String(valor || '').trim().toUpperCase();
  return /^[A-Z0-9]{2,10}$/.test(s) && /[A-Z]/.test(s) ? s : '';
}
// Identificador de una fila de la hoja Fondos: el ISIN de un fondo o el símbolo de una criptomoneda.
function idFondo(valor) { return isinValido(valor) || criptoValida(valor); }

function isinValido(valor) {
  const isin = String(valor || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin) ? isin : '';
}

function guardarFondo(x) {
  const isin = idFondo(x && x.id);
  if (!isin) throw new Error('ISIN o símbolo no válido');
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
  const r = borrarFila('Fondos', H_FONDOS, 1, idFondo(id) || id);
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
  const vacias = filas.filter(function (f) { return f[9] === '' || f[9] == null; }).map(function (f) { return String(f[0]); });
  const fallidas = filas.filter(function (f) { return typeof f[9] === 'string' && f[9].charAt(0) === '#'; }).map(function (f) { return String(f[0]); });
  filas.forEach(function (f) {
    const leido = f[7];
    if (typeof leido !== 'number' || !isFinite(leido) || !(leido > 0)) return;
    if (typeof f[5] === 'number' && f[5] > 0 && (leido / f[5] > 2 || leido / f[5] < 0.5)) return;   // un salto así es un error de lectura, no un precio
    const fecha = diaTexto(f[8], zona) || (leido === f[5] ? diaTexto(f[6], zona) : '') || hoy;   // sin fecha leída, la que hubiera si el precio no cambia
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
  ponerLecturas(h, vacias, fallidas, hoy);
  return cambiadas;
}

// Fórmulas que leen el precio y su fecha de la página del fondo. Se reescriben una vez al día (con el día en la
// dirección, para que la hoja vuelva a pedir la página), en los fondos que aún no las tienen y, como mucho una vez
// por hora, en los que la petición haya fallado.
function ponerLecturas(h, vacias, fallidas, hoy) {
  const props = PropertiesService.getScriptProperties();
  const todas = props.getProperty('lecturaDia') !== hoy;
  const hora = hoy + 'T' + Utilities.formatDate(new Date(), zonaHoraria(), 'HH');
  const reintento = !todas && fallidas.length > 0 && props.getProperty('lecturaHora') !== hora;
  const n = h.getLastRow() - 1;
  if (n < 1 || (!todas && !vacias.length && !reintento)) return;
  const ingles = /^(en|ja|zh|ko|th|he|hi)/i.test(String(SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetLocale() || ''));
  const sep = ingles ? ',' : ';';
  const isines = h.getRange(2, 1, n, 1).getValues();
  for (let i = 0; i < isines.length; i++) {
    const isin = idFondo(isines[i][0]);
    if (!isin) continue;
    const toca = todas || vacias.indexOf(isin) > -1 || (reintento && fallidas.indexOf(isin) > -1);
    if (!toca) continue;
    const sello = (reintento && fallidas.indexOf(isin) > -1 ? hora : hoy).replace(/[-T]/g, '');
    const fila = i + 2, celda = 'J' + fila;
    if (!isinValido(isin)) {   // criptomoneda: Google Finance y, si no la tiene, CoinGecko (responde {"bitcoin":{"eur":56000.1}})
      const cg = CRIPTO_PRECIO + (COINGECKO[isin] || isin.toLowerCase()) + '&d=' + sello;
      const crudoC = 'REGEXEXTRACT(' + celda + sep + '"""eur"":([0-9.eE-]+)")';
      h.getRange(fila, 10).setFormula('=IFERROR(GOOGLEFINANCE("CURRENCY:' + isin + 'EUR")' + sep + 'TEXTJOIN(" "' + sep + 'TRUE' + sep + 'IMPORTDATA("' + cg + '")))');
      h.getRange(fila, 8).setFormula('=IF(ISNUMBER(' + celda + ')' + sep + celda + sep + (ingles ? 'VALUE(' + crudoC + ')' : 'VALUE(SUBSTITUTE(' + crudoC + sep + '"."' + sep + '","))') + ')');
      h.getRange(fila, 9).setFormula('=TODAY()');
      continue;
    }
    const url = FUENTE_PRECIO + isin + '-x?d=' + sello;
    const crudo = 'REGEXEXTRACT(' + celda + sep + '"""price"":""?([0-9.]+)")';
    // La página solo da el trozo con el precio y la fecha (la propia consulta los recorta): el bloque entero de
    // Finect ya pasa de 50.000 caracteres y la celda daba «Resultado demasiado grande».
    const ld = "//script[@type='application/ld+json'][contains(.,'offers')]";
    const consulta = "concat('\"price\":',substring-before(substring-after(" + ld + ",'\"price\":'),','),' '," +
      "//*[contains(.,'Fecha de valor liquidativo')][not(*[contains(.,'Fecha de valor liquidativo')])],' '," +
      "//*[contains(text(),'Datos a ')])";   // Finect pone la fecha de una forma u otra según la página
    h.getRange(fila, 10).setFormula('=IMPORTXML("' + url + '"' + sep + '"' + consulta.replace(/"/g, '""') + '")');
    h.getRange(fila, 8).setFormula(ingles ? '=VALUE(' + crudo + ')' : '=VALUE(SUBSTITUTE(' + crudo + sep + '"."' + sep + '","))');
    h.getRange(fila, 9).setFormula('=REGEXEXTRACT(' + celda + sep + '"(?:liquidativo:|Datos a)\\s*([0-9]{1,2}/[0-9]{1,2}/[0-9]{4})")');
  }
  if (todas) props.setProperty('lecturaDia', hoy);
  if (reintento) props.setProperty('lecturaHora', hora);
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
      if (aplicarMovimiento(aviso, m) || aplicarAviso(aviso, m)) aplicados++;
      hechos.push(m.id);
    }
  });
  props.setProperty('correoHechos', JSON.stringify(hechos.slice(-150)));
  try { nombrarEsperados(); } catch (err) { /* un recibo sin nombre no rompe la lectura */ }
  return { ok: true, nuevos: nuevos, aplicados: aplicados };
}

// Correo de un movimiento concreto (p. ej. un pago con tarjeta): se apunta con su nombre y su categoría.
// Si ya está apuntado (por Apple Pay o por otro correo del mismo pago) no se repite; si un aviso de saldo ya lo
// dejó «sin identificar», se le pone nombre. Con soloNombrar (al repasar correos viejos) solo se ponen nombres.
// Un recibo anunciado («se cargará el recibo…») se guarda y nombra el «sin identificar» que llegue ese día.
function aplicarMovimiento(aviso, m, soloNombrar) {
  const reglas = aviso.movimientos || [];
  for (let r = 0; r < reglas.length; r++) {
    const regla = reglas[r], hallado = regla.patron.exec(m.texto);
    if (!hallado) continue;
    const importe = leerImporte(hallado[regla.importe]);
    if (typeof importe !== 'number' || !(importe > 0)) return false;
    const comercio = regla.nombre ? regla.nombre(importe) : bonito(hallado[regla.comercio]).replace(/[\s,.]+$/, ''), fin = hallado[regla.fin], tipo = regla.tipo;
    const cuentas = leerCuentas();
    const c = cuentas.filter(function (x) { return x.tarjetas.some(function (t) { return t.indexOf(fin) > -1; }); })[0] ||
      cuentas.filter(function (x) { return x.terminaEn === fin; })[0] ||
      cuentas.filter(function (x) { return x.terminaEn && x.tarjetas.some(function (t) { return t.toLowerCase().indexOf(aviso.banco.toLowerCase()) > -1; }); })[0];
    if (!c && !regla.aportacion) return false;
    if (regla.recibo) { guardarEsperado({ dia: hallado[regla.dia], importe: importe, comercio: comercio, cuenta: c.id }); nombrarEsperados(); return true; }
    if (regla.transferencia) return apuntarTransferencia(c, cuentas, importe, m.t, soloNombrar);
    if (regla.aportacion) {
      const origen = cuentas.filter(function (x) { return x.terminaEn === fin; })[0];
      const destino = cuentas.filter(function (x) { return sinTildes(x.nombre).indexOf(sinTildes(aviso.banco)) > -1; })[0];
      return origen && destino ? apuntarTransferencia(origen, cuentas, importe, m.t, soloNombrar, destino) : false;
    }
    const zona = zonaHoraria(), t = m.t;
    const ms = function (g) { return Utilities.parseDate(conSegundos(g.fecha), zona, F_FECHA).getTime(); };
    const igual = function (g) { return tipoValido(g.tipo) === tipo && Math.abs((Number(g.importe) || 0) - importe) < 0.005; };
    const gastos = leerGastos();
    const yaEsta = gastos.some(function (g) {
      if (!igual(g) || g.comercio === SIN_IDENTIFICAR) return false;
      const d = Math.abs(ms(g) - t);
      return (g.origen === 'Apple Pay' && d <= MOV_APPLE_PAY_MIN * 60000) || (d <= MOV_MISMO_DIAS * 864e5 && parecido(g.comercio, comercio));
    });
    if (yaEsta) return true;
    const h = hoja('Gastos', H_GASTOS);
    const duda = gastos.filter(function (g) { return igual(g) && g.origen === ORIGEN_BANCO && g.comercio === SIN_IDENTIFICAR && g.cuenta === c.id && Math.abs(ms(g) - t) <= MOV_MISMO_DIAS * 864e5; })[0];
    const categoria = tipo === 'gasto' ? categorizar(comercio) : '';
    if (duda) {
      const fila = buscarFila(h, 8, duda.id);
      h.getRange(fila, 2).setValue(texto(comercio));
      h.getRange(fila, 4, 1, 2).setValues([[tipo === 'gasto' ? texto('Tarjeta **' + fin) : '', categoria]]);
      return true;
    }
    if (soloNombrar) return true;
    h.appendRow([new Date(t), texto(comercio), importe, tipo === 'gasto' ? texto('Tarjeta **' + fin) : '', categoria, ORIGEN_BANCO, '', nuevoId(), c.id, tipo, '']);
    return true;
  }
  return false;
}
// Transferencia enviada: a la cuenta conjunta si es su aportación de cada mes (el importe de su presupuesto); si no, un gasto.
function apuntarTransferencia(c, cuentas, importe, t, soloNombrar, destinoSabido) {
  const conjunta = cuentas.filter(function (x) { return x.rol === 'conjunta'; })[0];
  const pres = leerPresupuestos().filter(function (p) { return sinTildes(p.nombre) === 'cuenta conjunta'; })[0];
  const destino = destinoSabido || (conjunta && pres && Math.abs(pres.limite - importe) < 0.005 ? conjunta : null);
  const zona = zonaHoraria(), h = hoja('Gastos', H_GASTOS), h0 = function () { return h; };
  const ms = function (g) { return Utilities.parseDate(conSegundos(g.fecha), zona, F_FECHA).getTime(); };
  const gastos = leerGastos();
  const cerca = function (g) { return Math.abs((Number(g.importe) || 0) - importe) < 0.005 && g.cuenta === c.id && Math.abs(ms(g) - t) <= MOV_MISMO_DIAS * 864e5; };
  const previa = gastos.filter(function (g) { return cerca(g) && g.comercio !== SIN_IDENTIFICAR && (tipoValido(g.tipo) === 'traspaso' || /transferencia/i.test(g.comercio)); })[0];
  if (previa) {
    // Si ya estaba como «Transferencia enviada» y ahora se sabe a qué cuenta fue, pasa a ser un traspaso.
    if (destino && tipoValido(previa.tipo) === 'gasto') {
      const n = buscarFila(h0(), 8, previa.id);
      h0().getRange(n, 2).setValue(texto('Traspaso a ' + destino.nombre));
      h0().getRange(n, 5).setValue('');
      h0().getRange(n, 10, 1, 2).setValues([['traspaso', destino.id]]);
    }
    return true;
  }
  const fila = destino
    ? ['Traspaso a ' + destino.nombre, importe, '', '', ORIGEN_BANCO, '', c.id, 'traspaso', destino.id]
    : ['Transferencia enviada', importe, '', CATEGORIA_POR_DEFECTO, ORIGEN_BANCO, '', c.id, 'gasto', ''];
  if (!destino) {
    // Si ese mismo importe acaba de entrar en otra cuenta tuya (avisado por su notificación), es un traspaso a ella.
    const entrada = gastos.filter(function (g) {
      return tipoValido(g.tipo) === 'ingreso' && g.origen === ORIGEN_NOTIF && g.cuenta && g.cuenta !== c.id &&
        Math.abs((Number(g.importe) || 0) - importe) < 0.005 && Math.abs(ms(g) - t) <= 864e5;
    })[0];
    if (entrada) {
      const otra = cuentas.filter(function (x) { return x.id === entrada.cuenta; })[0];
      const n = buscarFila(h, 8, entrada.id);
      h.getRange(n, 2, 1, 5).setValues([[texto('Traspaso a ' + (otra ? otra.nombre : entrada.cuenta)), importe, '', '', ORIGEN_BANCO]]);
      h.getRange(n, 9, 1, 3).setValues([[c.id, 'traspaso', entrada.cuenta]]);
      return true;
    }
  }
  const duda = gastos.filter(function (g) { return cerca(g) && g.comercio === SIN_IDENTIFICAR && tipoValido(g.tipo) === 'gasto'; })[0];
  if (duda) {
    const n = buscarFila(h, 8, duda.id);
    h.getRange(n, 2, 1, 5).setValues([[texto(fila[0]), fila[1], fila[2], fila[3], fila[4]]]);
    h.getRange(n, 9, 1, 3).setValues([[fila[6], fila[7], fila[8]]]);
    return true;
  }
  if (soloNombrar) return true;
  h.appendRow([new Date(t), texto(fila[0]), fila[1], fila[2], fila[3], fila[4], fila[5], nuevoId(), fila[6], fila[7], fila[8]]);
  return true;
}
/* ------------------------------------------------ notificaciones de las apps del banco */
// El atajo manda { app, titulo, texto } de cada notificación. Se guarda tal cual en «Notificaciones» (para afinar la
// lectura) y, si dice un importe y si entra o sale, se apunta en la cuenta de esa app: «Has recibido 50,00 € de Pablo».
const H_NOTIF = ['Fecha', 'App', 'Título', 'Texto', 'Resultado'];
const ORIGEN_NOTIF = 'Notificación';
function importeDeTexto(t) {
  const m = /(?:([\d.]+,\d{1,2}|\d+(?:\.\d{1,2})?)\s*(?:€|EUR))|(?:(?:€|EUR)\s*([\d.]+,\d{1,2}|\d+(?:\.\d{1,2})?))/i.exec(t);
  return m ? leerImporte(m[1] || m[2]) : '';
}
function leerNotificacion(app, titulo, texto) {
  const t = (titulo + '. ' + texto).replace(/\s+/g, ' ').trim(), n = sinTildes(t);
  const importe = importeDeTexto(t);
  if (!(importe > 0)) return null;
  let tipo = '';
  if (/(recibid|has recibido|te ha enviado|te han enviado|ingres|abonad|entrante|intereses|reembolso|devolucion|nomina)/.test(n)) tipo = 'ingreso';
  else if (/(pagado|has pagado|pago|cargo|has enviado|enviado|retirad|compra|domiciliad|recibo)/.test(n)) tipo = 'gasto';
  if (!tipo) return null;
  const quien = /(?:de|a|desde|para)\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñü.'-]+(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñü.'-]+){0,2})/.exec(t.replace(/^[^.]*\.\s*/, ''));
  const bizum = /bizum/.test(n), interes = /interes/.test(n);
  let nombre;
  if (interes) nombre = 'Intereses';
  else if (/nomina/.test(n)) nombre = 'Nómina';
  else if (bizum) nombre = (tipo === 'ingreso' ? 'Bizum de ' : 'Bizum a ') + (quien ? quien[1] : '').trim();
  else if (quien) nombre = (tipo === 'ingreso' ? 'Transferencia de ' : 'Pago a ') + quien[1].trim();
  else nombre = tipo === 'ingreso' ? 'Ingreso recibido' : 'Pago';
  return { importe: importe, tipo: tipo, nombre: nombre.replace(/\s+$/, '').replace(/ (de|a)$/, '') };
}
function apuntarNotificacion(datos) {
  const app = String(datos.app || '').trim(), titulo = String(datos.titulo || '').trim(), texto = String(datos.texto || '').trim();
  if (!app && !titulo && !texto) return { ok: true, prueba: true, mensaje: 'Conexión correcta.' };
  const registro = hoja('Notificaciones', H_NOTIF), fila = [new Date(), texto0(app), texto0(titulo), texto0(texto)];
  const anota = function (r) { registro.appendRow(fila.concat([r])); return r; };
  const lectura = leerNotificacion(app, titulo, texto);
  const cuentas = leerCuentas();
  const a = sinTildes(app).split(/\s+/)[0];
  const c = a ? cuentas.filter(function (x) { return sinTildes(x.nombre).indexOf(a) > -1 || x.tarjetas.some(function (t) { return sinTildes(t).indexOf(a) > -1; }); })[0] : null;
  if (!lectura) return { ok: true, apuntado: false, mensaje: anota('sin importe o sin saber si entra o sale') };
  if (!c) return { ok: true, apuntado: false, mensaje: anota('no sé de qué cuenta es la app «' + app + '»') };
  const ahora = Date.now(), zona = zonaHoraria(), h = hoja('Gastos', H_GASTOS);
  const ms = function (g) { return Utilities.parseDate(conSegundos(g.fecha), zona, F_FECHA).getTime(); };
  const gastos = leerGastos();
  const igual = function (g) { return tipoValido(g.tipo) === lectura.tipo && Math.abs((Number(g.importe) || 0) - lectura.importe) < 0.005; };
  const deLaCuenta = function (g) { return g.cuenta === c.id || (!g.cuenta && g.tarjeta && c.tarjetas.some(function (t) { return sinTildes(g.tarjeta).indexOf(sinTildes(t)) > -1; })); };
  // Repetida (la misma notificación dos veces) o ya apuntada por Apple Pay o por un correo del banco: no se repite.
  if (gastos.some(function (g) { return igual(g) && deLaCuenta(g) && g.comercio !== SIN_IDENTIFICAR && Math.abs(ms(g) - ahora) <= (g.origen === ORIGEN_NOTIF ? 10 : MOV_APPLE_PAY_MIN) * 60000; }))
    return { ok: true, apuntado: false, mensaje: anota('ya estaba apuntado') };
  // Dinero que entra y que salió de otra cuenta tuya (el correo del Santander no dice a dónde va): es un traspaso.
  if (lectura.tipo === 'ingreso') {
    const salida = gastos.filter(function (g) {
      return tipoValido(g.tipo) === 'gasto' && g.cuenta && g.cuenta !== c.id && Math.abs((Number(g.importe) || 0) - lectura.importe) < 0.005 &&
        (g.comercio === 'Transferencia enviada' || g.comercio === SIN_IDENTIFICAR) && Math.abs(ms(g) - ahora) <= 864e5;
    })[0];
    if (salida) {
      const n = buscarFila(h, 8, salida.id);
      h.getRange(n, 2).setValue(texto0('Traspaso a ' + c.nombre));
      h.getRange(n, 5).setValue('');
      h.getRange(n, 10, 1, 2).setValues([['traspaso', c.id]]);
      return { ok: true, apuntado: true, id: salida.id, mensaje: anota('traspaso desde otra cuenta tuya: ' + lectura.importe) };
    }
  }
  const categoria = lectura.tipo === 'gasto' ? categorizar(lectura.nombre) : '';
  const duda = gastos.filter(function (g) { return igual(g) && g.cuenta === c.id && g.comercio === SIN_IDENTIFICAR && Math.abs(ms(g) - ahora) <= MOV_MISMO_DIAS * 864e5; })[0];
  if (duda) {
    const n = buscarFila(h, 8, duda.id);
    h.getRange(n, 2).setValue(texto0(lectura.nombre));
    if (lectura.tipo === 'gasto') h.getRange(n, 5).setValue(categoria);
    return { ok: true, apuntado: true, id: duda.id, mensaje: anota('nombra «sin identificar»: ' + lectura.nombre) };
  }
  const id = nuevoId();
  h.appendRow([new Date(), texto0(lectura.nombre), lectura.importe, '', categoria, ORIGEN_NOTIF, '', id, c.id, lectura.tipo, '']);
  return { ok: true, apuntado: true, id: id, nombre: lectura.nombre, importe: lectura.importe, tipo: lectura.tipo, cuenta: c.id, mensaje: anota('apuntado: ' + lectura.tipo + ' ' + lectura.importe + ' ' + lectura.nombre) };
}
function texto0(v) { return texto(String(v || '').slice(0, 300)); }

// Mismo comercio aunque lo escriban distinto ("Delikia Sp" / "DELIKIA SP", "Repsol Waylet" / "REPSOL"): las 4 primeras letras.
function parecido(a, b) {
  const n = function (t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '').slice(0, 4); };
  return n(a).length >= 3 && n(a) === n(b);
}
// Recibos anunciados: se guardan hasta que llega su cargo (o pasan diez días).
function guardarEsperado(e) {
  const props = PropertiesService.getScriptProperties();
  let lista = [];
  try { lista = JSON.parse(props.getProperty('recibosEsperados') || '[]'); } catch (err) { lista = []; }
  if (!lista.some(function (x) { return x.dia === e.dia && x.importe === e.importe && x.cuenta === e.cuenta; })) lista.push(e);
  props.setProperty('recibosEsperados', JSON.stringify(lista.slice(-40)));
}
function nombrarEsperados() {
  const props = PropertiesService.getScriptProperties();
  let lista = [];
  try { lista = JSON.parse(props.getProperty('recibosEsperados') || '[]'); } catch (err) { lista = []; }
  if (!lista.length) return 0;
  const zona = zonaHoraria(), hoy = Utilities.formatDate(new Date(), zona, 'yyyy-MM-dd');
  const gastos = leerGastos(), h = hoja('Gastos', H_GASTOS);
  let n = 0;
  const quedan = lista.filter(function (e) {
    const desde = sumarDias(e.dia, -2), hasta = sumarDias(e.dia, 4);
    const g = gastos.filter(function (x) {
      const dia = String(x.fecha).slice(0, 10);
      return x.comercio === SIN_IDENTIFICAR && x.origen === ORIGEN_BANCO && x.cuenta === e.cuenta && tipoValido(x.tipo) === 'gasto' &&
        Math.abs((Number(x.importe) || 0) - e.importe) < 0.005 && dia >= desde && dia <= hasta;
    })[0];
    if (g) {
      const fila = buscarFila(h, 8, g.id);
      h.getRange(fila, 2).setValue(texto('Recibo ' + e.comercio));
      h.getRange(fila, 5).setValue(categorizar(e.comercio));
      g.comercio = 'Recibo ' + e.comercio; n++;
      return false;
    }
    return hoy <= sumarDias(e.dia, 10);
  });
  props.setProperty('recibosEsperados', JSON.stringify(quedan));
  return n;
}
function sumarDias(dia, n) {
  const p = String(dia).split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.toISOString().slice(0, 10);
}
// Vuelve a leer los correos de los últimos días solo para poner nombre a lo que quedó «sin identificar».
function repasarCorreo(dias) {
  let nombrados = 0;
  AVISOS.forEach(function (aviso) {
    const lista = Gmail.Users.Messages.list('me', { q: 'from:' + aviso.remitente + ' newer_than:' + (dias || 10) + 'd', maxResults: 100 });
    (lista.messages || []).map(function (m) {
      const completo = Gmail.Users.Messages.get('me', m.id, { format: 'full' });
      return { id: m.id, t: Number(completo.internalDate), texto: textoDelCorreo(completo) };
    }).sort(function (a, b) { return a.t - b.t; }).forEach(function (m) {
      const antes = leerGastos().filter(function (g) { return g.comercio === SIN_IDENTIFICAR; }).length;
      aplicarMovimiento(aviso, m, true);
      if (leerGastos().filter(function (g) { return g.comercio === SIN_IDENTIFICAR; }).length < antes) nombrados++;
    });
  });
  return { ok: true, nombrados: nombrados + nombrarEsperados(), quedan: leerGastos().filter(function (g) { return g.comercio === SIN_IDENTIFICAR; }).length };
}
// "CAPPUCCINO SEVI" -> "Cappuccino Sevi"; lo que ya viene en mayúsculas y minúsculas se deja igual.
function bonito(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s.\-\/])([a-zà-ÿ])/g, function (x, a, b) { return a + b.toUpperCase(); });
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
    .replace(/&nbsp;/gi, ' ').replace(/&euro;/gi, '€').replace(/&#42;|&ast;/gi, '*')
    .replace(/&([aeiouAEIOU])(acute|grave|uml);/g, function (x, v, k) { return v.normalize('NFD') + { acute: '\u0301', grave: '\u0300', uml: '\u0308' }[k]; })
    .replace(/&([nN])tilde;/g, function (x, v) { return v + '\u0303'; }).replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, function (x, n) { return String.fromCharCode(Number(n)); }).replace(/&[a-z#0-9]+;/gi, ' ');
  return [partes.plano, html, mensaje.snippet || ''].join(' ').normalize('NFC').replace(/\s+/g, ' ');
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

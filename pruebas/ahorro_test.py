"""Prueba de los papeles de las cuentas, los traspasos y la pestaña Ahorro, con un servidor de mentira."""
import asyncio, json, subprocess, sys, time
from datetime import datetime
from playwright.async_api import async_playwright
API = "https://script.google.com/macros/s/"
K = "clave-de-prueba"
hoy = datetime.now()
def mes(d):   # mes de hace d meses, "AAAA-MM"
    y, m = hoy.year, hoy.month - d
    while m < 1: m += 12; y -= 1
    return "%04d-%02d" % (y, m)
M0, M1, M2 = mes(0), mes(1), mes(2)
HOY = hoy.strftime("%Y-%m-%d")
MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
def cta(i, nombre, saldo, orden, **k): return dict(id=i, nombre=nombre, saldo=saldo, fechaSaldo=M1 + "-15T10:00:00", tarjetas=k.get("tarjetas", []), orden=orden, terminaEn=k.get("fin", ""), rol="", objetivo=None, aportado=None, fechaAportado="")
def mov(i, fecha, comercio, importe, tipo="gasto", cuenta="san", **k): return dict(id=i, fecha=fecha, comercio=comercio, importe=importe, tarjeta=k.get("tarjeta", ""), categoria=k.get("cat", ""), origen=k.get("origen", "Banco"), cuenta=cuenta, tipo=tipo, destino=k.get("destino", ""))
bd = {"cuentas": [cta("san", "Banco Santander", 1000, 1, tarjetas=["Santander"], fin="0061"), cta("rev", "Revolut (Conjunta)", 300, 2, tarjetas=["Revolut"]), cta("tr", "Trade Republic", 4000, 3), cta("mi", "MyInvestor", 9000, 4)],
      "presupuestos": [{"id": "supermercado", "nombre": "Supermercado", "limite": 350, "orden": 1}, {"id": "restaurantes", "nombre": "Restaurantes", "limite": 150, "orden": 2}],
      "gastos": [mov("h1", M2 + "-05T09:00:00", "Traspaso a Trade Republic", 300, "traspaso", destino="tr"),
                 mov("h2", M1 + "-05T09:00:00", "Traspaso a Trade Republic", 300, "traspaso", destino="tr"),
                 mov("h3", M1 + "-05T08:00:00", "Nómina", 2000, "ingreso"),
                 mov("h4", M1 + "-05T20:00:00", "Bizum a Juan", 50, cat="Restaurantes"),
                 mov("d1", HOY + "T00:30:00", "Sin identificar", 300, cat="Otros"),
                 mov("d2", HOY + "T00:31:00", "Sin identificar", 2000, "ingreso"),
                 mov("d3", HOY + "T00:32:00", "Sin identificar", 50, cat="Otros"),
                 mov("d4", HOY + "T00:33:00", "Sin identificar", 200, cat="Otros"),
                 mov("d5", HOY + "T00:34:00", "Sin identificar", 400, cat="Otros"),
                 mov("p1", HOY + "T00:40:00", "Mercadona", 30, cuenta="", tarjeta="Revolut", cat="Supermercado", origen="Apple Pay"),
                 mov("p2", HOY + "T00:41:00", "Repsol", 40, cuenta="", tarjeta="Santander", cat="Gasolina", origen="Apple Pay")],
      "saldos": [{"dia": M1 + "-20", "total": 14000, "cuentas": {}}]}
def api(body):
    d = json.loads(body)
    if d["clave"] != K: return {"ok": False, "error": "Clave incorrecta"}
    a = d.get("accion")
    if a == "leer": return dict(ok=True, **json.loads(json.dumps(bd)))
    col, op = a.split("."); lista = bd.setdefault(col + "s", [])
    if op == "guardar":
        x = d[col]; lista[:] = [y for y in lista if y["id"] != x["id"]] + [x]
    else: lista[:] = [y for y in lista if y["id"] != d["id"]]
    return {"ok": True, "id": d.get("id")}
async def main():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8767", "--bind", "127.0.0.1"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
    fallos = []
    def ok(c, m): (fallos.append(m) if not c else None); print(("ok    " if c else "FALLO ") + m)
    g = lambda i: [x for x in bd["gastos"] if x["id"] == i][0]
    c = lambda i: [x for x in bd["cuentas"] if x["id"] == i][0]
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, locale="es-ES")
            pg = await ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            async def ruta(route): await route.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body=json.dumps(api(route.request.post_data)))
            await pg.route(API + "**", ruta)
            await pg.goto("http://127.0.0.1:8767/index.html"); await pg.fill("#k-clave", K); await pg.click("#k-entrar"); await pg.wait_for_timeout(300)
            await pg.click("#sync"); await pg.wait_for_timeout(900)
            # --- lo que se repite se reconoce solo
            ok(g("d1")["tipo"] == "traspaso" and g("d1")["destino"] == "tr" and g("d1")["cuenta"] == "san" and g("d1")["comercio"] == "Traspaso a Trade Republic" and g("d1")["fecha"] == HOY + "T00:30:00", "aprende: una salida de 300 € como las de otros meses pasa a ser el traspaso de siempre")
            ok(g("d2")["comercio"] == "Nómina" and g("d2")["tipo"] == "ingreso" and g("d2")["categoria"] == "", "aprende: el ingreso de 2.000 € se reconoce como la nómina")
            ok(g("d3")["comercio"] == "Sin identificar" and g("d4")["comercio"] == "Sin identificar", "aprende: un importe pequeño visto una sola vez, o uno nuevo, no se toca")
            # --- para qué es cada cuenta
            await pg.click('[data-tab="ahorro"]'); await pg.wait_for_timeout(150)
            ok(await pg.locator(".papel").count() == 4 and await pg.locator("#v-ahorro .ticket").count() == 0 and await pg.locator('[data-papeles="0"]').count() == 0, "ahorro: sin papeles, lo primero es decir para qué es cada cuenta")
            for i, r in (("san", "gasto"), ("rev", "conjunta"), ("tr", "ahorro"), ("mi", "inversion")):
                await pg.click('[data-papel="%s"][data-id="%s"]' % (r, i)); await pg.wait_for_timeout(200)
            ok([c(i)["rol"] for i in ("san", "rev", "tr", "mi")] == ["gasto", "conjunta", "ahorro", "inversion"] and c("san")["terminaEn"] == "0061" and c("san")["saldo"] == 1000 and await pg.locator(".papel").count() == 4, "ahorro: el papel de cada cuenta se guarda en la hoja sin tocar lo demás")
            await pg.click('[data-papeles="0"]'); await pg.wait_for_timeout(150)
            tk = await pg.inner_text("#v-ahorro .ticket")
            ok(await pg.locator(".papel").count() == 0 and "+300,00" in tk and "15 % de lo que ha entrado" in tk and "+2.000,00" in tk, "ahorro: el mes muestra lo apartado y qué parte es de lo que ha entrado (%s)" % tk.replace("\n", " | "))
            # --- identificar una salida como traspaso
            await pg.click('[data-tab="cuentas"]'); await pg.click('[data-gasto="d4"]'); await pg.wait_for_timeout(200)
            v0 = [await pg.is_visible("#f-que-grupo"), await pg.is_hidden("#f-otra-grupo"), await pg.is_visible("#f-cat-grupo"), await pg.inner_text("#f-que-traspaso-txt")]
            await pg.click("#f-que-grupo label:nth-child(2)"); await pg.wait_for_timeout(100)
            v1 = [await pg.is_visible("#f-otra-grupo"), await pg.is_hidden("#f-cat-grupo"), await pg.is_hidden("#f-cuenta-grupo")]
            otras = await pg.eval_on_selector_all("#f-otras input", "e => e.map(x => x.value)")
            await pg.click('#f-otras label:has(input[value="tr"])'); await pg.screenshot(path="/tmp/claude-0/-home-claude-mis-gastos/dd460c8b-0267-5366-b734-87cbbda3f7a9/scratchpad/w-traspaso.png"); await pg.evaluate("document.querySelectorAll('#f-otras input').forEach(i => i.checked = false)")
            await pg.click("#f-guardar"); e1 = await pg.inner_text("#f-error")
            await pg.click('#f-otras label:has(input[value="mi"])'); await pg.click("#f-guardar"); await pg.wait_for_timeout(300)
            ok(v0 == [True, True, True, "Traspaso a otra cuenta"] and v1 == [True, True, True] and otras == ["rev", "tr", "mi"] and "Elige a qué cuenta" in e1, "traspaso: al identificar una salida se puede decir a qué cuenta fue")
            ok(g("d4")["tipo"] == "traspaso" and g("d4")["cuenta"] == "san" and g("d4")["destino"] == "mi" and g("d4")["comercio"] == "Traspaso a MyInvestor" and g("d4")["categoria"] == "" and g("d4")["origen"] == "Banco", "traspaso: se guarda con origen y destino")
            await pg.click('[data-gasto="d5"]'); await pg.click("#f-que-grupo label:nth-child(2)"); await pg.click('#f-otras label:has(input[value="rev"])'); await pg.fill("#f-comercio", "Aportación mensual"); await pg.click("#f-guardar"); await pg.wait_for_timeout(300)
            sal = await pg.eval_on_selector_all(".cuenta", "els=>els.map(e=>e.querySelector('.nombre').textContent+'='+e.querySelector('.saldo').textContent)")
            sal.append("MyInvestor=" + await pg.eval_on_selector('#v-patrimonio .obj[data-cuenta="mi"] .cifra', "e => e.textContent"))   # las inversiones ya no salen en Inicio
            ok(sal == ["Banco Santander=2.010,00 €", "Revolut (Conjunta)=670,00 €", "Trade Republic=4.300,00 €", "MyInvestor=9.200,00 €"], "traspaso: resta de una cuenta y suma en la otra (%s)" % sal)
            # --- la conjunta: cuenta lo que aportas, no lo que se paga desde ella
            await pg.click('[data-tab="resumen"]'); tot = await pg.inner_text("#v-resumen .total"); cats = await pg.inner_text("#v-resumen .cats"); lin = await pg.inner_text("#v-resumen .lineas")
            ok(tot == "490,00 €" and "Cuenta conjunta" in cats and "400,00" in cats and "Supermercado\n0,00" in cats.replace(" €", "").replace(" de 350", "") and "+2.000,00" in lin, "conjunta: tu gasto es la aportación (400) y el pago hecho con Revolut no cuenta (%s)" % tot)
            await pg.click('[data-tab="movimientos"]'); mm = await pg.inner_text("#v-movimientos")
            await pg.click('[data-filtro="Cuenta conjunta"]'); mf = await pg.eval_on_selector_all("#v-movimientos .mov .m-n", "e => e.map(x => x.textContent)")
            await pg.click('[data-filtro=""]')
            ok("No cuenta en tus gastos" in mm and mf == ["Aportación mensual"], "conjunta: en Movimientos se ve qué cuenta y se puede filtrar la aportación (%s)" % mf)
            # --- pestaña Ahorro con datos
            await pg.click('[data-tab="ahorro"]'); await pg.wait_for_timeout(150)
            tk = await pg.inner_text("#v-ahorro .ticket")
            ok("+500,00" in tk and "25 % de lo que ha entrado" in tk and tk.count("+300,00") == 1 and "+200,00" in tk, "ahorro: suma ahorro e inversión por separado (%s)" % tk.replace("\n", " | "))
            await pg.click('#v-ahorro .obj[data-cuenta="tr"]'); await pg.wait_for_timeout(200)
            v = [await pg.is_checked('#c-roles input[value="ahorro"]'), await pg.is_visible("#c-objetivo-grupo"), await pg.is_hidden("#c-aportado-grupo")]
            await pg.fill("#c-objetivo", "6000"); await pg.click("#c-guardar"); await pg.wait_for_timeout(300)
            tr = await pg.inner_text('#v-ahorro .obj[data-cuenta="tr"]'); falta = 1700; n = -(-falta // 300); y, m = hoy.year, hoy.month + n
            while m > 12: m -= 12; y += 1
            ok(v == [True, True, True] and c("tr")["objetivo"] == 6000 and c("tr")["rol"] == "ahorro" and c("tr")["saldo"] == 4000 and "72 %" in tr and "6.000" in tr and ("A este ritmo: %s %d" % (MESES[m - 1], y)) in tr, "ahorro: objetivo fijo con su barra y cuándo se llega a este ritmo (%s)" % tr.replace("\n", " | "))
            await pg.click('#v-ahorro .obj[data-cuenta="mi"]'); await pg.wait_for_timeout(200)
            v = [await pg.inner_text("#c-saldo-etq"), await pg.is_visible("#c-aportado-grupo"), await pg.input_value("#c-saldo")]
            await pg.fill("#c-aportado", "8000"); await pg.click("#c-guardar"); await pg.wait_for_timeout(300)
            mi = await pg.inner_text('#v-ahorro .obj[data-cuenta="mi"]')
            ok(v[0].lower().startswith("valor de hoy") and v[1] and v[2] == "9200,00" and c("mi")["aportado"] == 8000 and len(c("mi")["fechaAportado"]) == 19 and c("mi")["saldo"] == 9000 and "8.000,00" in mi and "+1.200,00" in mi and "+15,0 %" in mi and "+200,00" in mi, "inversión: valor, aportado y ganancia (%s)" % mi.replace("\n", " | "))
            await pg.click('#v-ahorro .obj[data-cuenta="mi"]'); await pg.wait_for_timeout(200); ap = await pg.input_value("#c-aportado"); await pg.click("#c-guardar"); await pg.wait_for_timeout(300)
            ok(ap == "8000,00" and c("mi")["aportado"] == 8000, "inversión: guardar sin cambiar nada no mueve lo aportado")
            barras = await pg.eval_on_selector_all("#v-ahorro g[data-mes]", "e => e.map(x => x.getAttribute('data-mes') + ':' + x.querySelectorAll('path').length)")
            ok(barras == [mes(5) + ":0", mes(4) + ":0", mes(3) + ":0", M2 + ":1", M1 + ":1", M0 + ":2"] and await pg.locator("#v-ahorro .claves span").count() == 2, "mes a mes: una barra por mes con ahorro e inversión apilados (%s)" % barras)
            # --- Patrimonio: todo junto, con las inversiones; Inicio: solo las cuentas del día a día
            await pg.click('[data-tab="patrimonio"]'); await pg.wait_for_timeout(150)
            evo = await pg.locator("#v-patrimonio .evo").count(); pie = await pg.inner_text("#v-patrimonio .sec:last-of-type .pie"); sin_evo = await pg.locator("#v-ahorro .evo").count()
            ok(evo == 1 and sin_evo == 0 and ("Desde el 20 ") in pie and "+2.180,00" in pie, "evolución: en Patrimonio, línea desde la primera foto hasta hoy (%s)" % pie.replace("\n", " | "))
            num = lambda x: float(x.replace("\u00a0", "").replace("€", "").replace(".", "").replace(",", ".").replace("−", "-").strip())
            tot = num(await pg.inner_text("#v-patrimonio .total")); pill = await pg.inner_text("#v-patrimonio .ticket .pill")
            grupos = await pg.eval_on_selector_all("#v-patrimonio .linea", "e => e.map(x => x.querySelector('.l').textContent.trim() + '=' + x.querySelector('.v').textContent)")
            inv = await pg.eval_on_selector_all("#v-patrimonio .objs .obj", "e => e.map(x => x.dataset.cuenta + ':' + x.querySelector('.logo').textContent)")
            lista = await pg.eval_on_selector_all("#v-patrimonio .fila-c", "e => e.map(x => x.dataset.cuenta + ':' + x.querySelector('small').textContent)")
            cab = await pg.inner_text("#mes-txt"); ocultos = [await pg.is_hidden("#mes-ant"), await pg.is_hidden("#mes-sig"), await pg.is_hidden("#nuevo")]; trozos = await pg.locator("#v-patrimonio .comp i").count()
            ok(len(grupos) == 4 and grupos[0].startswith("Día a día") and grupos[1].startswith("Cuenta conjunta") and grupos[2].startswith("Ahorro") and grupos[3].startswith("Inversión") and abs(sum(num(x.split("=")[1]) for x in grupos) - tot) < 0.01
               and inv == ["mi:MY"] and lista == ["san:Día a día", "rev:Cuenta conjunta", "tr:Ahorro"] and cab == "Patrimonio" and ocultos == [True, True, True] and trozos == 4 and "+2.180,00" in pill,
               "patrimonio: total con inversiones, reparto por grupos, inversiones y cuentas (%s | %s | %s)" % (grupos, inv, lista))
            await pg.screenshot(path="/tmp/claude-0/-home-claude-mis-gastos/dd460c8b-0267-5366-b734-87cbbda3f7a9/scratchpad/w-patrimonio.png", full_page=True)
            await pg.click('#v-patrimonio .fila-c[data-cuenta="tr"]'); await pg.wait_for_timeout(200); ficha = await pg.input_value("#c-nombre"); await pg.click("#hc-cerrar")
            await pg.click('[data-tab="cuentas"]'); await pg.wait_for_timeout(150)
            ini = await pg.eval_on_selector_all("#v-cuentas .cuenta", "e => e.map(x => x.dataset.cuenta + ':' + (x.querySelector('.logo img') ? 'img' : x.querySelector('.logo').textContent) + ':' + x.children.length)")
            centro = await pg.eval_on_selector(".rosco .centro", "e => [...e.children].map(x => x.textContent)"); cab = await pg.inner_text("#mes-txt")
            ok(ficha == "Trade Republic" and ini == ["san:img:3", "rev:img:3", "tr:img:3"] and centro[0] == "Saldo total" and centro[2] == "Sin inversiones" and abs(num(centro[1]) + num(grupos[3].split("=")[1]) - tot) < 0.01 and cab == "Inicio"
               and await pg.locator("#v-cuentas [data-nueva-cuenta]").count() == 1, "inicio: solo las cuentas que no son de inversión, cada una con su logo, y el gráfico sin inversiones (%s | %s)" % (ini, centro))
            await pg.screenshot(path="/tmp/claude-0/-home-claude-mis-gastos/dd460c8b-0267-5366-b734-87cbbda3f7a9/scratchpad/w-inicio.png", full_page=True)
            menu = await pg.eval_on_selector_all(".tabs button", "e => e.map(b => b.textContent.trim() + ':' + b.querySelectorAll('svg').length)")
            ok(menu == ["Inicio:1", "Resumen:1", "Movimientos:1", "Presupuestos:1", "Ahorro:1", "Patrimonio:1"], "menú: seis pestañas con icono y nombre (%s)" % menu)
            await pg.click('[data-tab="ahorro"]'); await pg.wait_for_timeout(150)
            await pg.screenshot(path="/tmp/claude-0/-home-claude-mis-gastos/dd460c8b-0267-5366-b734-87cbbda3f7a9/scratchpad/w-ahorro-1.png")
            await pg.evaluate("document.querySelector('#v-ahorro .graf').scrollIntoView({block:'center'})"); await pg.wait_for_timeout(100)
            await pg.screenshot(path="/tmp/claude-0/-home-claude-mis-gastos/dd460c8b-0267-5366-b734-87cbbda3f7a9/scratchpad/w-ahorro-2.png"); await pg.evaluate("scrollTo(0,0)")
            await pg.dispatch_event('#v-ahorro g[data-mes="%s"] rect:last-of-type' % M1, "click"); await pg.wait_for_timeout(150)
            tk = await pg.inner_text("#v-ahorro .ticket"); cab = await pg.inner_text("#mes-txt")
            ok(MESES[int(M1[5:]) - 1] in cab.lower() and "+300,00" in tk and "mes cerrado" in tk.lower() and "15 %" in tk, "mes a mes: tocar un mes lo abre (%s)" % cab)
            await pg.click("#mes-hoy")
            # --- corregir: un traspaso reconocido solo que en realidad era un gasto
            await pg.click('[data-tab="movimientos"]'); await pg.click('[data-gasto="d1"]'); await pg.wait_for_timeout(200)
            v = [await pg.is_checked("#f-que-traspaso"), await pg.is_checked('#f-otras input[value="tr"]')]
            await pg.click("#f-que-grupo label:nth-child(1)"); await pg.fill("#f-comercio", "Dentista"); await pg.click("#f-categorias label:nth-child(1)"); await pg.click("#f-guardar"); await pg.wait_for_timeout(300)
            ok(v == [True, True] and g("d1")["tipo"] == "gasto" and g("d1")["destino"] == "" and g("d1")["cuenta"] == "san" and g("d1")["comercio"] == "Dentista" and g("d1")["categoria"] == "Supermercado", "corregir: un traspaso se puede volver a marcar como gasto")
            # --- cambiar los papeles más tarde
            await pg.click('[data-tab="ahorro"]'); await pg.click('[data-papeles="1"]'); await pg.wait_for_timeout(100)
            pres = await pg.eval_on_selector_all('.papel button[aria-pressed="true"]', "e => e.map(x => x.dataset.id + ':' + x.dataset.papel)")
            await pg.click('[data-papeles="0"]')
            ok(pres == ["san:gasto", "rev:conjunta", "tr:ahorro", "mi:inversion"], "ahorro: los papeles se pueden revisar después")
            tabs = await pg.eval_on_selector_all(".tabs button", "e => e.map(b => b.scrollWidth <= b.clientWidth)")
            ov = await pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            fab = [await pg.is_hidden("#nuevo")]; await pg.click('[data-tab="resumen"]'); fab.append(await pg.is_visible("#nuevo"))
            ok(fab == [True, True], "el botón de añadir gasto no tapa la pestaña Ahorro")
            # --- fondos de la cuenta de inversión
            bd["fondos"] = [dict(id="IE00BYX5MX67", nombre="Fidelity S&P 500 Index EUR P Acc", cuenta="mi", participaciones=422.02, fechaParticipaciones=HOY + "T00:10:00", precio=17.13, fechaPrecio=M0 + "-08"),
                            dict(id="ES0165265002", nombre="MyInvestor Nasdaq 100", cuenta="mi", participaciones=500.82, fechaParticipaciones=HOY + "T00:10:00", precio=1.8312, fechaPrecio=M0 + "-07")]
            f = lambda i: ([x for x in bd["fondos"] if x["id"] == i] or [None])[0]
            from datetime import timedelta
            bd["gastos"].append(mov("t9", (datetime.now() + timedelta(seconds=2)).strftime("%Y-%m-%dT%H:%M:%S"), "Traspaso a MyInvestor", 50, "traspaso", destino="mi"))
            await pg.click('[data-tab="ahorro"]'); await pg.wait_for_timeout(2200); await pg.click("#sync"); await pg.wait_for_timeout(500)
            mi = await pg.inner_text('#v-ahorro .obj[data-cuenta="mi"]')
            ok("Aportado: 8.000,00" in mi and "9.250,00" in mi, "fondos: con fondos, lo aportado no cuenta dos veces el traspaso (lo suma el servidor al confirmarse la compra) (%s)" % mi.replace("\n", " | ")[:120])
            ok("Fidelity S&P 500 Index EUR P Acc" in mi and "7.229,20" in mi and "422,02 part. × 17,13 €" in mi and "precio del 8 " in mi and "917,10" in mi and "× 1,8312 €" in mi, "fondos: la tarjeta de inversión enseña cada fondo con participaciones, precio y valor (%s)" % mi.replace("\n", " | "))
            await pg.screenshot(path="/tmp/claude-0/-home-claude-mis-gastos/dd460c8b-0267-5366-b734-87cbbda3f7a9/scratchpad/w-fondos-1.png", full_page=True)
            await pg.click('#v-ahorro .obj[data-cuenta="mi"]'); await pg.wait_for_timeout(200)
            v = [await pg.is_visible("#c-fondos-grupo"), await pg.is_disabled("#c-saldo"), await pg.locator(".c-fondo").count(), await pg.input_value('[data-fondo="IE00BYX5MX67"]')]
            await pg.screenshot(path="/tmp/claude-0/-home-claude-mis-gastos/dd460c8b-0267-5366-b734-87cbbda3f7a9/scratchpad/w-fondos-2.png")
            await pg.fill('[data-fondo="IE00BYX5MX67"]', "430,5"); await pg.fill("#c-f-isin", "malo"); await pg.fill("#c-f-part", "10"); await pg.click("#c-guardar"); e1 = await pg.inner_text("#c-error")
            await pg.fill("#c-f-isin", "ie00b03hcz61"); await pg.fill("#c-f-nombre", "Vanguard Global"); await pg.click("#c-guardar"); await pg.wait_for_timeout(600)
            ok(v == [True, True, 2, "422,02"] and "no es válido" in e1 and f("IE00BYX5MX67")["participaciones"] == 430.5 and f("IE00BYX5MX67")["fechaParticipaciones"] > HOY + "T00:10:00" and f("IE00BYX5MX67")["nombre"].startswith("Fidelity") and f("ES0165265002")["participaciones"] == 500.82 and f("ES0165265002")["fechaParticipaciones"] == HOY + "T00:10:00"
               and f("IE00B03HCZ61") and f("IE00B03HCZ61")["cuenta"] == "mi" and f("IE00B03HCZ61")["participaciones"] == 10 and c("mi")["saldo"] == 9000 and c("mi")["aportado"] == 8000, "fondos: en la ficha se cambian las participaciones y se añade un fondo por su ISIN, sin tocar el valor a mano")
            await pg.click('#v-ahorro .obj[data-cuenta="mi"]'); await pg.wait_for_timeout(200); await pg.fill('[data-fondo="IE00B03HCZ61"]', ""); await pg.click("#c-guardar"); await pg.wait_for_timeout(600)
            ok(f("IE00B03HCZ61") is None and len(bd["fondos"]) == 2, "fondos: dejar las participaciones vacías quita el fondo")
            await pg.click('#v-ahorro .obj[data-cuenta="tr"]'); await pg.wait_for_timeout(200); sinf = await pg.is_hidden("#c-fondos-grupo") and await pg.is_enabled("#c-saldo"); await pg.click("#hc-cerrar")
            ok(sinf, "fondos: en una cuenta que no es de inversión no aparecen")
            await pg.reload(); await pg.wait_for_timeout(400)
            ok(await pg.is_visible('[data-tab="ahorro"]'), "tras recargar, la pestaña Ahorro sigue ahí (lo recuerda la copia local)")
            ok(len(tabs) == 6 and all(tabs) and ov == 0 and not errs, "seis pestañas que caben, sin desbordes ni errores de script %s" % errs)
            await b.close()
    finally:
        srv.terminate()
    print("TODO OK" if not fallos else "%d FALLOS" % len(fallos)); sys.exit(1 if fallos else 0)
asyncio.run(main())

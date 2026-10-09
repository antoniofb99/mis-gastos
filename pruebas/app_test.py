"""Prueba de la app con un servidor de mentira que imita la API de la hoja."""
import asyncio, json, subprocess, sys, time
from playwright.async_api import async_playwright
API = "https://script.google.com/macros/s/"
K = "clave-de-prueba"
bd = {"gastos": [{"id": "g1", "fecha": "2026-10-09T16:59:40", "comercio": "PRUEBA Mercadona", "importe": 12.5, "tarjeta": "Tarjeta de prueba", "categoria": "Supermercado", "origen": "Prueba", "cuenta": ""}],
      "presupuestos": [{"id": "supermercado", "nombre": "Supermercado", "limite": 350, "orden": 1}, {"id": "restaurantes", "nombre": "Restaurantes", "limite": 150, "orden": 2}],
      "cuentas": [{"id": "banco-santander", "nombre": "Banco Santander", "saldo": 144.01, "fechaSaldo": "2026-10-09T18:02:22", "tarjetas": ["Santander"], "orden": 1},
                  {"id": "tarjeta-comida", "nombre": "Tarjeta comida (Restaurante)", "saldo": 212.05, "fechaSaldo": "2026-10-09T18:03:49", "tarjetas": [], "orden": 4}]}
llamadas = []; caido = {"v": False}
def api(body):
    d = json.loads(body); llamadas.append(d.get("accion"))
    assert "clave" in d
    if d["clave"] != K: return {"ok": False, "error": "Clave incorrecta"}
    a = d.get("accion")
    if a == "leer": return dict(ok=True, **json.loads(json.dumps(bd)))
    col, op = a.split("."); lista = bd[col + "s"]
    if op == "guardar":
        x = d[col]; lista[:] = [y for y in lista if y["id"] != x["id"]] + [x]
    else: lista[:] = [y for y in lista if y["id"] != d["id"]]
    return {"ok": True, "id": d.get("id")}
async def main():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "--bind", "127.0.0.1"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
    out = {}; fallos = []
    def ok(c, m): (fallos.append(m) if not c else None); print(("ok    " if c else "FALLO ") + m)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, locale="es-ES")
            pg = await ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            async def ruta(route):
                rq = route.request
                assert rq.method == "POST" and "clave" not in rq.url
                if caido["v"]: return await route.abort()
                await route.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body=json.dumps(api(rq.post_data)))
            await pg.route(API + "**", ruta)
            await pg.goto("http://127.0.0.1:8765/index.html"); await pg.wait_for_timeout(500)
            ok(await pg.is_visible("#entrada"), "sin clave: pide la clave")
            await pg.screenshot(path="/tmp/claude-0/-home-claude-mis-gastos/dd460c8b-0267-5366-b734-87cbbda3f7a9/scratchpad/w-entrada.png")
            await pg.fill("#k-clave", "mala"); await pg.click("#k-entrar"); await pg.wait_for_timeout(300)
            ok("no es correcta" in await pg.inner_text("#k-error"), "clave mala: avisa")
            await pg.fill("#k-clave", K); await pg.click("#k-entrar"); await pg.wait_for_timeout(400)
            ok(not await pg.is_visible("#entrada"), "clave buena: entra")
            sal = lambda: pg.eval_on_selector_all(".cuenta", "els=>els.map(e=>e.querySelector('.nombre').textContent+'='+(e.querySelector('.saldo')?e.querySelector('.saldo').textContent:'-'))")
            s = await sal(); ok(s == ["Banco Santander=144,01 €", "Tarjeta comida (Restaurante)=212,05 €"], "muestra las cuentas: %s" % s)
            await pg.screenshot(path="/tmp/claude-0/-home-claude-mis-gastos/dd460c8b-0267-5366-b734-87cbbda3f7a9/scratchpad/w-cuentas.png")
            # recarga: entra sola con la clave guardada
            await pg.reload(); await pg.wait_for_timeout(500)
            ok(not await pg.is_visible("#entrada") and len(await sal()) == 2, "recarga: entra sin pedir clave")
            # gasto a mano en Santander
            await pg.click("#nuevo"); await pg.fill("#f-importe", "10,01"); await pg.fill("#f-comercio", "Café"); await pg.click("#f-categorias label:nth-child(2)")
            await pg.click("#f-cuentas label:nth-child(2)"); await pg.click("#f-guardar"); await pg.wait_for_timeout(400)
            s = await sal(); g = [x for x in bd["gastos"] if x["comercio"] == "Café"]
            ok(s[0] == "Banco Santander=134,00 €" and len(g) == 1 and g[0]["importe"] == 10.01 and g[0]["cuenta"] == "banco-santander" and g[0]["origen"] == "A mano" and len(g[0]["fecha"]) == 19, "gasto a mano: resta del saldo y llega a la hoja")
            # llega un pago de Apple Pay a la hoja (hora posterior al saldo anotado)
            from datetime import datetime, timedelta
            ya = (datetime.now() + timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%S")
            bd["gastos"].append({"id": "gw1", "fecha": ya, "comercio": "Bar Central", "importe": 11.5, "tarjeta": "Edenred Ticket", "categoria": "Restaurantes", "origen": "Apple Pay", "cuenta": ""})
            bd["gastos"].append({"id": "gw2", "fecha": ya, "comercio": "Repsol", "importe": 34, "tarjeta": "Santander Débito", "categoria": "Gasolina", "origen": "Apple Pay", "cuenta": ""})
            await pg.click("#sync"); await pg.wait_for_timeout(400)
            s = await sal(); pend = await pg.eval_on_selector_all(".pend strong", "e=>e.map(x=>x.textContent)")
            ok(s[0] == "Banco Santander=100,00 €" and "Edenred Ticket" in pend, "pago de Apple Pay: se resta de Santander y la tarjeta nueva pide cuenta (%s, %s)" % (s[0], pend))
            await pg.select_option('.pend select[data-tarjeta="Edenred Ticket"]', "tarjeta-comida"); await pg.wait_for_timeout(400)
            s = await sal(); c = [x for x in bd["cuentas"] if x["id"] == "tarjeta-comida"][0]
            ok(s[1] == "Tarjeta comida (Restaurante)=200,55 €" and c["tarjetas"] == ["Edenred Ticket"], "asignar tarjeta: queda guardado en la hoja y resta (%s)" % s[1])
            # presupuesto
            await pg.click('[data-tab="presupuestos"]'); await pg.fill("#pre-restaurantes", "200"); await pg.press("#pre-restaurantes", "Enter"); await pg.wait_for_timeout(400)
            ok([x for x in bd["presupuestos"] if x["id"] == "restaurantes"][0]["limite"] == 200, "cambiar un límite llega a la hoja")
            # el banco avisa por correo: el servidor pone el saldo y deja dos movimientos sin identificar
            t1 = (datetime.now() - timedelta(seconds=120)).strftime("%Y-%m-%dT%H:%M:%S"); t2 = (datetime.now() - timedelta(seconds=60)).strftime("%Y-%m-%dT%H:%M:%S")
            corte = (datetime.now() + timedelta(seconds=2)).strftime("%Y-%m-%dT%H:%M:%S")
            cs = [x for x in bd["cuentas"] if x["id"] == "banco-santander"][0]; cs.update(saldo=143.0, fechaSaldo=corte, terminaEn="0061")
            bd["gastos"].append({"id": "gb1", "fecha": t1, "comercio": "Sin identificar", "importe": 1, "tarjeta": "", "categoria": "", "origen": "Banco", "cuenta": "banco-santander", "tipo": "ingreso", "destino": ""})
            bd["gastos"].append({"id": "gb2", "fecha": t2, "comercio": "Sin identificar", "importe": 2.01, "tarjeta": "", "categoria": "Otros", "origen": "Banco", "cuenta": "banco-santander", "tipo": "gasto", "destino": ""})
            await pg.click('[data-tab="resumen"]'); antes = await pg.inner_text("#v-resumen .total")
            await pg.click('[data-tab="cuentas"]'); await pg.click("#sync"); await pg.wait_for_timeout(400)
            s = await sal(); dudas = await pg.eval_on_selector_all("#v-cuentas .sec .mov", "e=>e.map(x=>x.querySelector('.m-n').textContent+' '+x.querySelector('.m-i').textContent)")
            det = await pg.inner_text(".cuenta .det")
            ok(s[0] == "Banco Santander=143,00\u00a0€" and dudas == ["Sin identificar 2,01\u00a0€", "Sin identificar +1,00\u00a0€"] and "Saldo según tu banco" in det, "aviso del banco: saldo del banco y dos movimientos por identificar (%s | %s)" % (s[0], dudas))
            await pg.click('[data-tab="resumen"]'); despues = await pg.inner_text("#v-resumen .total"); lineas = await pg.inner_text("#v-resumen .lineas")
            num = lambda x: float(x.replace("\u00a0€", "").replace(".", "").replace(",", "."))
            ok(abs(num(despues) - num(antes) - 2.01) < 0.001 and "Ingresos del mes" in lineas and "+1,00" in lineas, "el gasto sin identificar cuenta en el mes y el ingreso no (%s -> %s)" % (antes, despues))
            await pg.click('[data-tab="cuentas"]'); await pg.click('[data-gasto="gb2"]'); await pg.wait_for_timeout(200)
            tit = await pg.inner_text("#hoja-titulo"); await pg.fill("#f-comercio", "Bizum a Juan"); await pg.click("#f-categorias label:nth-child(2)"); await pg.click("#f-guardar"); await pg.wait_for_timeout(400)
            g2 = [x for x in bd["gastos"] if x["id"] == "gb2"][0]
            ok("Qué fue" in tit and g2["comercio"] == "Bizum a Juan" and g2["categoria"] == "Restaurantes" and g2["tipo"] == "gasto" and g2["origen"] == "Banco" and g2["cuenta"] == "banco-santander" and g2["fecha"] == t2, "identificar un gasto: guarda nombre y categoría sin tocar lo demás")
            await pg.click('[data-gasto="gb1"]'); await pg.wait_for_timeout(200)
            oculto = await pg.is_hidden("#f-cat-grupo"); await pg.fill("#f-comercio", "Bizum de Sandra"); await pg.click("#f-guardar"); await pg.wait_for_timeout(400)
            g1 = [x for x in bd["gastos"] if x["id"] == "gb1"][0]; s = await sal()
            ok(oculto and g1["comercio"] == "Bizum de Sandra" and g1["tipo"] == "ingreso" and g1["categoria"] == "" and await pg.locator("#v-cuentas .sec .mov").count() == 0 and s[0] == "Banco Santander=143,00\u00a0€", "identificar un ingreso: sin categoría, sigue siendo ingreso y el saldo no cambia")
            await pg.click('[data-cuenta="banco-santander"]'); await pg.wait_for_timeout(200); fin = await pg.input_value("#c-fin")
            await pg.fill("#c-tarjetas", "Santander, Mastercard"); await pg.click("#c-guardar"); await pg.wait_for_timeout(400)
            cs = [x for x in bd["cuentas"] if x["id"] == "banco-santander"][0]
            ok(fin == "0061" and cs["terminaEn"] == "0061" and cs["saldo"] == 143.0 and cs["fechaSaldo"] == corte, "editar la cuenta conserva las 4 cifras y el saldo del banco")
            await pg.screenshot(path="/tmp/claude-0/-home-claude-mis-gastos/dd460c8b-0267-5366-b734-87cbbda3f7a9/scratchpad/w-banco.png", full_page=True)
            # sin conexión: el cambio se deshace y avisa
            caido["v"] = True
            await pg.click('[data-tab="cuentas"]'); await pg.click("#nuevo"); await pg.fill("#f-importe", "50"); await pg.click("#f-categorias label:nth-child(1)"); await pg.click("#f-cuentas label:nth-child(2)"); await pg.click("#f-guardar"); await pg.wait_for_timeout(500)
            s = await sal(); t = await pg.inner_text("#toast")
            ok(s[0] == "Banco Santander=143,00 €" and "Sin conexión" in t, "sin conexión: no resta y avisa (%s | %s)" % (s[0], t))
            caido["v"] = False
            ov = await pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            ok(ov == 0 and not errs, "sin desbordes ni errores de script %s" % errs)
            ok(set(llamadas) >= {"leer", "gasto.guardar", "cuenta.guardar", "presupuesto.guardar"}, "acciones usadas: %s" % sorted(set(llamadas)))
            await b.close()
    finally:
        srv.terminate()
    print("TODO OK" if not fallos else "%d FALLOS" % len(fallos)); sys.exit(1 if fallos else 0)
asyncio.run(main())

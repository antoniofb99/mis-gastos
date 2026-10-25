"""Devoluciones: un ingreso con categoría resta del gasto de esa categoría y no cuenta como ingreso."""
import asyncio, json, subprocess, sys, time
from datetime import date
from playwright.async_api import async_playwright
g = {}; exec(open(__file__.replace("devolucion_test.py", "app_test.py"), encoding="utf-8").read().split("async def main")[0], g)
hoy = date.today().isoformat()
def mov(i, com, imp, tipo, cat):
    return {"id": i, "fecha": hoy + "T10:00:00", "comercio": com, "importe": imp, "tarjeta": "", "categoria": cat, "origen": "Banco", "cuenta": "banco-santander", "tipo": tipo, "destino": ""}
g["bd"]["gastos"] = [mov("c1", "Cena con amigos", 80, "gasto", "Restaurantes"), mov("b1", "Bizum de Pablo", 20, "ingreso", "Restaurantes"),
                     mov("b2", "Bizum de Ana", 20, "ingreso", ""), mov("s1", "Mercadona", 30, "gasto", "Supermercado")]
async def main():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8768", "--bind", "127.0.0.1"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
    fallos = []
    def ok(c, m): (fallos.append(m) if not c else None); print(("ok    " if c else "FALLO ") + m)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(); ctx = await b.new_context(viewport={"width": 390, "height": 844}, has_touch=True, locale="es-ES")
            pg = await ctx.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
            async def ruta(route): await route.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body=json.dumps(g["api"](route.request.post_data)))
            await pg.route(g["API"] + "**", ruta)
            await pg.add_init_script("localStorage.setItem('mg-clave', '%s')" % g["K"])
            await pg.goto("http://localhost:8768/index.html"); await pg.wait_for_timeout(900)
            await pg.click('[data-tab="resumen"]'); await pg.wait_for_timeout(500)
            cifra = await pg.inner_text("#v-resumen .rosco .cifra"); lineas = await pg.inner_text("#v-resumen .lineas")
            ok(cifra.replace(" ", " ") == "90,00 €" and "+20,00" in lineas, "la devolución resta de lo gastado y solo el otro Bizum cuenta como ingreso (%s | %s)" % (cifra, lineas.replace("\n", " ")))
            await pg.click('[data-tab="movimientos"]'); await pg.wait_for_timeout(500)
            sub = await pg.eval_on_selector('#v-movimientos [data-gasto="b1"] .m-s', "e => e.textContent")
            ok(sub.startswith("Devolución · Restaurantes"), "en movimientos se ve como devolución (%s)" % sub)
            await pg.click('#v-movimientos [data-gasto="b2"]'); await pg.wait_for_timeout(300)
            ley = await pg.inner_text("#f-cat-leyenda"); visible = await pg.is_visible("#f-cat-grupo")
            await pg.click("#f-categorias label:has-text('Restaurantes')"); await pg.click("#f-guardar"); await pg.wait_for_timeout(500)
            b2 = [x for x in g["bd"]["gastos"] if x["id"] == "b2"][0]
            ok(visible and "devolución" in ley.lower() and b2["categoria"] == "Restaurantes" and b2["tipo"] == "ingreso", "al editar un ingreso se puede marcar como devolución de una categoría (%s, %s)" % (ley, b2))
            await pg.click('#v-movimientos [data-gasto="s1"]'); await pg.wait_for_timeout(300)
            no = await pg.is_visible("#f-categorias [data-solo-ingreso]"); ley2 = await pg.inner_text("#f-cat-leyenda"); await pg.click("#hoja-cerrar")
            ok(not no and ley2.lower() == "categoría", "en un gasto no sale la opción de ingreso")
            await pg.click('[data-tab="resumen"]'); await pg.wait_for_timeout(500)
            cifra2 = await pg.inner_text("#v-resumen .rosco .cifra")
            ok(cifra2.replace(" ", " ") == "70,00 €" and not errs, "con las dos devoluciones, Restaurantes queda en lo que pagaste tú (%s) %s" % (cifra2, errs))
            await b.close()
    finally: srv.terminate()
    print("TODO OK" if not fallos else "%d FALLOS" % len(fallos)); sys.exit(1 if fallos else 0)
asyncio.run(main())

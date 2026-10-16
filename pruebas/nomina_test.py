"""Mes de nómina: el mes empieza con la primera nómina que entra (aunque haya dos)."""
import asyncio, json, subprocess, sys, time
from datetime import date, timedelta
from playwright.async_api import async_playwright
g = {}; exec(open(__file__.replace("nomina_test.py", "app_test.py"), encoding="utf-8").read().split("async def main")[0], g)
MES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre']
CORTO = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic']
hoy = date.today()
n1 = hoy - timedelta(days=40); n1b = n1 + timedelta(days=2); n2 = hoy - timedelta(days=10); n2b = n2 + timedelta(days=3)
f = lambda d, h="10:00:00": d.isoformat() + "T" + h
def mov(i, d, com, imp, tipo="gasto", cat="Supermercado"):
    return {"id": i, "fecha": f(d), "comercio": com, "importe": imp, "tarjeta": "", "categoria": cat if tipo == "gasto" else "", "origen": "A mano", "cuenta": "banco-santander", "tipo": tipo, "destino": ""}
g["bd"]["gastos"] = [
    mov("n1", n1, "Nómina Inetum", 1500, "ingreso"), mov("n1b", n1b, "Nomina club", 600, "ingreso"),
    mov("n2", n2, "NÓMINA INETUM", 1500, "ingreso"), mov("n2b", n2b, "Nómina club", 600, "ingreso"),
    mov("a", n2 - timedelta(days=1), "Mercadona", 30), mov("b", n2, "Mercadona", 7), mov("c", hoy, "Mercadona", 5),
    mov("x", n2 - timedelta(days=2), "Bizum Sandra", 50, "ingreso"),
]
async def main():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8767", "--bind", "127.0.0.1"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
    fallos = []
    def ok(c, m): (fallos.append(m) if not c else None); print(("ok    " if c else "FALLO ") + m)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(); ctx = await b.new_context(viewport={"width": 390, "height": 844}, has_touch=True, locale="es-ES")
            pg = await ctx.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
            async def ruta(route): await route.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body=json.dumps(g["api"](route.request.post_data)))
            await pg.route(g["API"] + "**", ruta)
            await pg.add_init_script("localStorage.setItem('mg-clave', '%s')" % g["K"])
            await pg.goto("http://localhost:8767/index.html"); await pg.wait_for_timeout(900)
            await pg.click('[data-tab="movimientos"]'); await pg.wait_for_timeout(500)
            etq = MES[(n2 + timedelta(days=15)).month - 1]
            sub = await pg.inner_text("#mes-sub"); tit = await pg.inner_text("#mes-txt")
            movs = await pg.eval_on_selector_all("#v-movimientos .mov .m-n", "e => e.map(x => x.textContent)")
            ok(tit.lower() == etq and sub.lower().startswith("nómina · %d %s – " % (n2.day, CORTO[n2.month - 1])), "el mes en curso empieza el día de la primera nómina y se llama como el mes que vive (%s | %s)" % (tit, sub))
            ok(sorted(movs) == sorted(["NÓMINA INETUM", "Nómina club", "Mercadona", "Mercadona"]), "entran las dos nóminas y lo gastado desde la primera; lo de la víspera, no (%s)" % movs)
            await pg.click("#mes-ant"); await pg.wait_for_timeout(400)
            movs2 = await pg.eval_on_selector_all("#v-movimientos .mov .m-n", "e => e.map(x => x.textContent)"); sub2 = await pg.inner_text("#mes-sub")
            fin = n2 - timedelta(days=1)
            ok(sorted(movs2) == sorted(["Nómina Inetum", "Nomina club", "Mercadona", "Bizum Sandra"]) and sub2.lower() == "nómina · %d %s – %d %s" % (n1.day, CORTO[n1.month - 1], fin.day, CORTO[fin.month - 1]),
               "el mes anterior va de su primera nómina a la víspera de la siguiente (%s | %s)" % (sub2, movs2))
            ok(not errs, "sin errores de script %s" % errs)
            await b.close()
    finally: srv.terminate()
    print("TODO OK" if not fallos else "%d FALLOS" % len(fallos)); sys.exit(1 if fallos else 0)
asyncio.run(main())

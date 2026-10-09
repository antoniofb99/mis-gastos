"""Sella la versión en index.html y version.json antes de subir cambios de la app.
Uso: python3 publicar.py   (luego git add, commit y push)"""
import json, re, datetime
v = datetime.datetime.now().strftime("%Y-%m-%d.%H%M")
s = open("index.html", encoding="utf-8").read()
s2, n = re.subn(r"var VERSION = '[^']*';", "var VERSION = '%s';" % v, s)
assert n == 1, "no encuentro VERSION en index.html"
open("index.html", "w", encoding="utf-8").write(s2)
json.dump({"v": v}, open("version.json", "w"))
print("Versión", v)

# Mis Gastos

App web personal para ver el saldo de cada cuenta, los gastos del mes y los presupuestos por categoría.

- `index.html`: la app (una sola página, sin dependencias salvo las fuentes).
- `manifest.webmanifest`, `icon-*.png`: para añadirla a la pantalla de inicio del móvil a pantalla completa.
- `servidor/Codigo.gs`: script de Google Apps Script que vive en la hoja de cálculo. Recibe los pagos de Apple Pay desde Atajos y sirve los datos a la app.
- `pruebas/`: pruebas del servidor (`node pruebas/servidor.test.js`) y de la app (`python3 pruebas/app_test.py` y `python3 pruebas/ahorro_test.py`, necesitan Playwright).

Cada cuenta tiene un papel (gasto diario, ahorro, inversión o conjunta). Las salidas de la cuenta de gasto que se identifican como traspaso a una cuenta de ahorro o de inversión son lo que la pestaña Ahorro cuenta como apartado; la aportación a la cuenta conjunta cuenta como gasto y los pagos hechos desde ella no.

La app se puede bloquear con Face ID (engranaje de ajustes, arriba a la derecha). Es un cierre de pantalla hecho con una llave de acceso del teléfono; la clave de la hoja sirve de repuesto.

Los datos no están en este repositorio: viven en una hoja de Google privada y solo se leen con una clave que se guarda en cada dispositivo.
En `servidor/Codigo.gs` la clave es un marcador; la real solo está en el script desplegado.

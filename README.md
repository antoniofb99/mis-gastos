# Mis Gastos

App web personal para ver el saldo de cada cuenta, los gastos del mes y los presupuestos por categoría.

- `index.html`: la app (una sola página, sin dependencias salvo las fuentes).
- `manifest.webmanifest`, `icon-*.png`: para añadirla a la pantalla de inicio del móvil a pantalla completa.
- `servidor/Codigo.gs`: script de Google Apps Script que vive en la hoja de cálculo. Recibe los pagos de Apple Pay desde Atajos y sirve los datos a la app.
- `pruebas/`: pruebas del servidor (`node pruebas/servidor.test.js`) y de la app (`python3 pruebas/app_test.py`, necesita Playwright).

Los datos no están en este repositorio: viven en una hoja de Google privada y solo se leen con una clave que se guarda en cada dispositivo.
En `servidor/Codigo.gs` la clave es un marcador; la real solo está en el script desplegado.

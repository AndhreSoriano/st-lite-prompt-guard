# Lite Prompt Guard (Mobile) para SillyTavern

Extensión ultraligera para **SillyTavern** diseñada específicamente para navegadores móviles (**Android / Brave**), pensada como reemplazo rápido y estable de `NemoPresetExt`.

## Instalación rápida desde SillyTavern (Git URL)

1. Desactiva o desinstala `NemoPresetExt` en **Extensions → Manage Extensions** (si lo tenías instalado).
2. En SillyTavern, abre **Extensions → Install Extension**.
3. Pega la URL pública de este repositorio:
   ```text
   https://github.com/AndhreSoriano/st-lite-prompt-guard
   ```
4. Haz clic en **Install for all users** (o **Install for current user**) y recarga SillyTavern.

> **Configuración opcional:** En el panel de **Extensions → Lite Prompt Guard (Mobile)** puedes cambiar el nombre del bloque objetivo para el botón rápido (por defecto `Post-History Instructions`) y activar o desactivar el escudo CSS para `.mes_text`.

---

## 1. Diagnóstico técnico: por qué falla y va lento `NemoPresetExt` en Android / Brave

En navegadores móviles basados en Chromium (como Brave en Android), la memoria RAM disponible por pestaña y el presupuesto de cálculo por frame (~16,6 ms a 60 Hz) son mucho más estrictos que en escritorio. El diseño de `NemoPresetExt` choca directamente con la arquitectura interna de SillyTavern en tres puntos críticos:

### 1.1. Sobrecarga del DOM, *Reflows* y memoria RAM
En SillyTavern, el gestor nativo (`PromptManager.js`) ya es costoso al actualizar la UI:
- `PromptManager.renderPromptManager()` vacía `#completion_prompt_manager` (`innerHTML = ''`) y vuelve a inyectar cabecera y pie.
- `PromptManager.renderPromptManagerListItems()` vacía `#completion_prompt_manager_list` (`innerHTML = ''`) y reconstruye cada `<li class="completion_prompt_manager_prompt">` junto con sus *event listeners* individuales y `sortable()`.

`NemoPresetExt` añade capas pesadas de interfaz (modos de vista, bandejas de categorías, navegación, virtualización, *tooltips*, observadores y múltiples contenedores anidados). Cada vez que se abre el panel o se activa un toggle, el navegador móvil dispara **Forced Synchronous Layouts (layout thrashing)**, provocando congelamientos y picos de consumo de RAM.

### 1.2. Evaluación excesiva en presets grandes (60–100+ bloques)
Cuando se activa un toggle desde el flujo por defecto (`promptManager.render()` sin argumentos, es decir, `afterTryGenerate = true`), SillyTavern ejecuta `this.tryGenerate()` —una simulación completa (*dry-run*) de composición de contexto y conteo de tokens— antes de volver a pintar la lista. Sumado al indexado de metadatos y filtrado complejo en presets grandes, el hilo principal queda bloqueado.

### 1.3. Rotura de diseño CSS en los mensajes (Layout Shifting / Overlapping)
Muchos presets y reglas Regex insertan HTML o atributos `style="..."` generados por el modelo dentro de `.mes_text` con `position: absolute/fixed`, `z-index` elevados, `transform` o márgenes negativos. En pantallas estrechas de móvil, ese contenido escapa de `.mes_text` y se superpone sobre avatares y mensajes anteriores.

---

## 2. Qué hace `Lite Prompt Guard (Mobile)`

- **Cero reconstrucción del DOM:** No mueve, clona ni envuelve ningún `<li class="completion_prompt_manager_prompt">` nativo. Solo aplica o quita `.lpg-hidden { display: none !important; }` usando caché en `WeakMap` y `requestAnimationFrame`.
- **Buscador instantáneo con Debounce (120 ms):** Inyecta un único `<input type="text">` **justo antes** de `#completion_prompt_manager` (fuera del contenedor que SillyTavern vacía en cada render), evitando que se destruya el input o se cierre el teclado móvil al pulsar toggles.
- **Botón de acceso rápido para Jailbreak:** Añade un botón discreto (`JB: ON` / `JB: OFF`) en la barra superior (`#top-settings-holder`, con respaldo en `#nonQRFormItems`) que alterna `Post-History Instructions` (configurable) usando `promptManager.render(false)` para omitir el *dry-run* pesado de tokenización en móvil.
- **Escudo CSS anti-rotura para móvil:** Inyecta estilos de contención sobre `.mes_text` (`overflow: hidden !important; isolation: isolate !important;`) y normaliza `.mes_text *` (`position: static !important; max-width: 100% !important; overflow-wrap: break-word !important;`), neutralizando coordenadas, `transform` y márgenes negativos inline.

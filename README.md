# Lite Prompt Guard (Mobile) para SillyTavern

Extensión ultraligera para **SillyTavern** optimizada para **Termux + Android / Brave**, diseñada como reemplazo de `NemoPresetExt` para mantener presets grandes de **NemoEngine** (400–630+ bloques) ordenados y eliminar los tirones de rendimiento al usar el chat o borrar mensajes.

## Instalación rápida desde SillyTavern (Git URL)

1. Desactiva o desinstala `NemoPresetExt` en **Extensions → Manage Extensions** (si lo tenías instalado).
2. En SillyTavern, abre **Extensions → Install Extension**.
3. Pega la URL pública de este repositorio:
   ```text
   https://github.com/AndhreSoriano/st-lite-prompt-guard
   ```
4. Haz clic en **Install for all users** (o **Install for current user**) y recarga la página.

---

## 1. Qué problemas de SillyTavern y Nemo resuelve

1. **Congelamiento de varios segundos al recibir un mensaje del bot (262 Regex activos de NemoEngine):**
   - Los presets de `NemoEngine` traen **273 scripts Regex incrustados (262 activos, 237 de visualización)** —incluyendo `Mental Projection` (117), `Nemo + Magpie` (37), `Tracker UI` (19) y expresiones de hasta 6.464 caracteres— que SillyTavern ejecuta síncronamente en el hilo principal de Brave cada vez que termina el mensaje del bot (y repetidamente si usas **Streaming**).
   - **Solución 1 — Acelerador automático sin desactivar nada (v1.4.0):** intercepta `RegexProvider.instance.get()` y aplica un pre-filtro literal (`includes`) sobre el 88% de los Regex de Nemo (209/237) que requieren etiquetas específicas (`</mental_state>`, `<nemo_story`, etc.), logrando ~41× menos tiempo de CPU manteniendo todos los Regex activos y un contador en vivo (`Saltos rápidos`).
   - **Solución 2 — Optimizador en 1 clic:** en **Extensions → Lite Prompt Guard (Mobile) → Optimizador de Regex (Nemo)** también puedes desactivar solo los Regex visuales pesados o pausar todos los Regex del preset al instante.
2. **Congelamiento y bajones al abrir el menú de toggles o activar/desactivar/editar un módulo (`PromptManager.render`, `sortable()`, `saveSettings()`):**
   - Cada vez que activabas un toggle o guardabas una edición en SillyTavern, `handleToggle` y `handleSavePrompt` reconstruían los 629 nodos del Prompt Manager (`innerHTML = ''` + ~2.500 listeners + jQuery UI `.sortable()`), y cada clic disparaba 1 s después un `saveSettings()` completo (`JSON.stringify` de 3–8 MB + I/O en Termux) además de escaneos de `touch-punch`/Sizzle y `filter: drop-shadow` por icono en cada fila.
   - **Solución (v1.6.0):**
     - **Toggle O(1) (<0.1 ms) y expansión O(sección):** índice estructural en memoria (`pmIndex` + `Map` de `prompt_order`) que actualiza solo la fila `<li>` y el badge de su sección sin re-escanear los 630 nodos ni provocar mutaciones DOM redundantes.
     - **`jQuery UI .sortable()` + `touch-punch` desactivados por defecto:** elimina los listeners táctiles no pasivos, las búsquedas Sizzle y los reflujos en cada toque/scroll; incluye el botón **`⇅`** en la barra para activar el arrastre solo cuando quieras reordenar módulos.
     - **Persistencia inteligente en reposo:** agrupa todos tus toggles y guarda una sola vez tras una pausa de inactividad (3,5 s en `requestIdleCallback`), o de inmediato si cierras el panel, envías un mensaje, cambias de preset o sales de la pestaña.
     - **Aislamiento CSS y respuesta táctil móvil:** `contain: layout style paint` por fila, `touch-action: manipulation` y eliminación de `filter: drop-shadow` / `transition: all` en los iconos del Prompt Manager.
     - Mantienes el botón **`↻`** en la barra para recalcular tokens manualmente cuando quieras, y abrir `#left-nav-panel` sigue siendo en 0 ms si solo hubo mensajes nuevos o borrados.
3. **Bajón al borrar, editar o recibir mensajes (`PromptManager.renderDebounced`):**
   - En SillyTavern (`PromptManager.js`), cada `MESSAGE_DELETED`, `MESSAGE_EDITED` o `MESSAGE_RECEIVED` dispara `renderDebounced()` → `tryGenerate()` (simulación completa de contexto y conteo de tokens de los 400–630+ bloques de Nemo) y reconstruye toda la lista del Prompt Manager aunque el panel lateral esté **cerrado**.
   - **Solución:** el **Render Guard** pospone esos re-renders mientras `#left-nav-panel` está cerrado y solo actualiza cuando abres el panel.
2. **Lag al activar/desactivar módulos de Nemo:**
   - Activa el modo **Toggle rápido** (usa `render(false)` sin `tryGenerate()`), manteniendo un botón **`↻`** en la barra para recalcular tokens manualmente cuando lo necesites.
3. **Saturación del DOM con presets de 400–630+ bloques:**
   - Detecta los divisores nativos de Nemo (`===`, `⭐─`, `━`, `───`) y subcabeceras (`<...>`) **sin clonar ni mover ningún `<li>`**, iniciando colapsado para pintar solo ~20 cabeceras en pantalla.
   - Incluye barra persistente con buscador con *debounce* (120 ms), botón **`Solo ON`** y botones **`+` / `−`**.
4. **Scroll lento, consumo de GPU y RAM en Android/Brave:**
   - **`content-visibility: auto`** en mensajes del chat (`.mes`) y tarjetas de personajes (`.character_select`).
   - **Modo GPU Lite:** desactiva `backdrop-filter: blur`, sombras pesadas y transiciones UI en paneles y mensajes.
   - **Carga diferida (`loading="lazy"`, `decoding="async"`)** en imágenes y avatares.
   - **Auto-colapso** de bloques de razonamiento (`thinking` / `<details>`) en mensajes antiguos.
   - **Escudo CSS anti-rotura** para `.mes_text` que evita que HTML/CSS de presets se encime sobre avatares o mensajes anteriores.

---

## 2. Ajustes recomendados extra en Termux / SillyTavern

- En `config.yaml` de SillyTavern (Termux):
  - `performance.lazyLoadCharacters: true`
  - `thumbnails.enabled: true` (`format: 'webp'`, `quality: 75`)
- En **User Settings** de SillyTavern:
  - **# of messages to load:** `20` o `30` (reduce mucho la RAM inicial en móvil).
- En **Extensions → Manage Extensions**:
  - Desactiva extensiones integradas que no uses (TTS, Image Generation, Vector Storage, etc.).

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
   - **Solución (v1.3.0):** En **Extensions → Lite Prompt Guard (Mobile) → Optimizador de Regex (Nemo)** puedes desactivar en 1 toque solo los Regex visuales pesados (dejando intactos `Nemo Runtime` / `Nemo Story` / `Nemo Commands`) o pausar todos los Regex del preset al instante.
2. **Bajón al borrar, editar o recibir mensajes (`PromptManager.renderDebounced`):**
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

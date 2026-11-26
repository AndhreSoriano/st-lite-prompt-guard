# Lite Prompt Guard (Mobile) para SillyTavern

Extensión ultraligera para **SillyTavern** optimizada para **Termux + Android / Brave**, diseñada para acelerar SillyTavern de forma global con **cualquier preset** (predeterminado, personalizado, Marinara, Celia, PixiJB, NemoEngine, etc.), listas grandes de personajes, lorebooks y streaming.

## Instalación rápida desde SillyTavern (Git URL)

1. Desactiva o desinstala extensiones pesadas de gestión de presets (p. ej. `NemoPresetExt`) en **Extensions → Manage Extensions** si usabas alguna.
2. En SillyTavern, abre **Extensions → Install Extension**.
3. Pega la URL pública de este repositorio:
   ```text
   https://github.com/AndhreSoriano/st-lite-prompt-guard
   ```
4. Haz clic en **Install for all users** (o **Install for current user**) y recarga la página.

---

## 1. Optimizaciones globales incluidas (`v1.7.0`)

1. **Streaming Ligero + Acelerador automático de Regex (Global / Personaje / Preset):**
   - **Streaming ligero (v1.7.0):** durante el streaming (`STREAM_TOKEN_RECEIVED`), pospone automáticamente los scripts Regex puramente visuales/pesados (HTML complejo, tablas, `<style>`, SVG, `@keyframes` o expresiones largas) y los aplica una única vez al finalizar el mensaje, eliminando los tirones mientras el bot escribe.
   - **Pre-filtro literal O(1) (v1.4.0):** intercepta `RegexProvider.instance.get()` y verifica con `includes()` las subcadenas literales obligatorias antes de ejecutar la expresión regular completa, sin desactivar ningún script.
   - **Controles rápidos en 1 clic:** en **Extensions → Lite Prompt Guard (Mobile)** muestra estadísticas combinadas (Global, Personaje y Preset) y permite desactivar los Regex visuales pesados o pausar todos los Regex del preset actual al instante.

2. **Toggles instantáneos O(1) y secciones colapsables en Prompt Manager (cualquier preset):**
   - **Sin reconstrucción del DOM:** los toggles y ediciones de prompts existentes se aplican en el acto (`<0.1 ms`) sobre la fila `<li>` usando un índice en memoria (`pmIndex` + `Map` de `prompt_order`), sin volver a ejecutar `PromptManager.render()` ni escanear toda la lista.
   - **`jQuery UI .sortable()` + `touch-punch` desactivados por defecto (v1.6.0):** evita listeners táctiles no pasivos, búsquedas Sizzle y reflujos en cada toque/scroll; incluye el botón **`⇅`** en la barra para activar el arrastre solo cuando quieras reordenar módulos.
   - **Persistencia inteligente en reposo (v1.6.0):** agrupa todos tus cambios y ejecuta `saveSettings()` una sola vez tras 3,5 s de inactividad en `requestIdleCallback` (o de inmediato al cerrar el panel, enviar un mensaje, cambiar de preset o salir de la pestaña).
   - **Divisores universales colapsables (v1.7.0):** detecta cabeceras visuales estándar de cualquier preset (`===`, `---`, `***`, `___`, `═══`, `━━━`, `───`, `⭐─`, `✦─`, etc.) y subcabeceras `<...>` sin clonar nodos, con buscador con *debounce*, **`Solo ON`**, **`+` / `−`**, **`⇅`** y **`↻`** (recálculo manual de tokens).

3. **Render Guard contra lag al borrar, editar o recibir mensajes:**
   - En SillyTavern, `MESSAGE_DELETED`, `MESSAGE_EDITED` y `MESSAGE_RECEIVED` disparan `PromptManager.renderDebounced()` → `tryGenerate()` incluso con el panel lateral cerrado. El **Render Guard** pospone esos re-renders hasta que realmente necesites abrir el panel (apertura en 0 ms si solo cambió el chat).

4. **Virtualización CSS global, GPU Lite y limpieza móvil:**
   - **Virtualización `content-visibility: auto` (v1.7.0):** aplicada a mensajes del chat (`.mes`), tarjetas de personajes y grupos (`.character_select`), entradas de Lorebook/World Info (`.world_entry`), avatares de persona (`.avatar-container`) y listas de scripts Regex.
   - **Modo GPU Lite + pausa de `@keyframes` (v1.7.0):** desactiva `backdrop-filter: blur`, sombras y transiciones UI pesadas, y pausa animaciones CSS continuas en mensajes anteriores al último.
   - **Carga diferida (`loading="lazy"`, `decoding="async"`):** en imágenes del chat, lista de personajes, avatares de persona y barra `HotSwap`.
   - **Auto-colapso** de bloques de razonamiento (`thinking` / `<details>`) en mensajes antiguos y **Escudo CSS** en `.mes_text` para evitar solapamientos en pantalla móvil.

---

## 2. Ajustes recomendados extra en Termux / SillyTavern

- En `config.yaml` de SillyTavern (Termux):
  - `performance.lazyLoadCharacters: true`
  - `performance.memoryCacheCapacity: '50mb'`
  - `thumbnails.enabled: true` (`format: 'webp'`, `quality: 75`)
- En la lista de personajes de SillyTavern:
  - Mantén la paginación en `25` o `50` personajes por página.
- En **User Settings** de SillyTavern:
  - **# of messages to load:** `20` o `30` (reduce la RAM inicial en móvil).
  - **Streaming FPS:** `8`–`10` y desactiva `Smooth Streaming` / `Stream Fade-In`.
- En **Extensions → Manage Extensions**:
  - Desactiva extensiones integradas que no uses (`TTS`, `Image Generation`, `Vector Storage`, `Summarize`, etc.).
- Mantén en `OpenAI Settings` solo los presets que uses (cada preset grande de varios MB se carga en memoria al iniciar).

# Lite Prompt Guard (Mobile) para SillyTavern

Extensión ultraligera para **SillyTavern** (especialmente pensada para **Termux + Android / Brave**), diseñada como reemplazo de `NemoPresetExt` para mantener presets grandes de **NemoEngine** (400–630+ bloques) ordenados y fluidos sin reconstruir el DOM.

## Instalación rápida desde SillyTavern (Git URL)

1. Desactiva o desinstala `NemoPresetExt` en **Extensions → Manage Extensions** (si lo tenías instalado).
2. En SillyTavern, abre **Extensions → Install Extension**.
3. Pega la URL pública de este repositorio:
   ```text
   https://github.com/AndhreSoriano/st-lite-prompt-guard
   ```
4. Haz clic en **Install for all users** (o **Install for current user**) y recarga la página.

> **Configuración en Extensions → Lite Prompt Guard (Mobile):**
> - **Agrupar secciones de Nemo (`===`, `⭐─`, `━`) colapsables** (activado por defecto)
> - **Iniciar con secciones colapsadas** (activado por defecto: en móvil/Termux solo pinta ~20 cabeceras en vez de 600+ filas)
> - **Activar escudo CSS anti-rotura en mensajes (`.mes_text`)** (activado por defecto)

---

## 1. Diagnóstico técnico: por qué falla y va lento `NemoPresetExt` en Android / Termux

En navegadores móviles (Brave en Android) conectados a SillyTavern en Termux, el presupuesto de cálculo por frame y la memoria RAM por pestaña son muy reducidos:

1. **Sobrecarga del DOM y *Reflows*:** SillyTavern reconstruye el contenido de `#completion_prompt_manager` y `#completion_prompt_manager_list` mediante `innerHTML = ''` en cada render. `NemoPresetExt` intercepta esa lista e inyecta contenedores, grids, bandejas, *tooltips* y múltiples listeners extra, disparando *Forced Synchronous Layouts* (lag severo y cierres por falta de RAM).
2. **Evaluación excesiva en presets grandes:** Los presets de NemoEngine superan los 400–600 módulos. Renderizar y evaluar cientos de nodos visibles a la vez congela el scroll táctil en móvil.
3. **Rotura de diseño CSS en `.mes_text`:** Algunos presets o reglas Regex inyectan HTML/CSS con `position: absolute/fixed`, `z-index` altos, `transform` o márgenes negativos que se salen de la burbuja y se superponen sobre avatares o mensajes anteriores.

---

## 2. Qué hace `Lite Prompt Guard (Mobile)`

- **Cero reconstrucción del DOM:** No mueve, clona ni envuelve ningún `<li class="completion_prompt_manager_prompt">` nativo. Solo aplica clases CSS mínimas (`.lpg-section`, `.lpg-subheader`, `.lpg-open`, `.lpg-hidden`).
- **Organizador colapsable de NemoEngine:** Detecta los divisores nativos de Nemo (`=== ... ===`, `⭐─`, `━`, `───`) como carpetas colapsables con contador `activos/total` mediante pseudo-elementos CSS (`::before` y `::after`), y da jerarquía visual a las subcabeceras (`<Core: ...>`). Mantiene abiertas tus secciones aunque SillyTavern re-renderice la lista al pulsar un toggle.
- **Barra compacta fuera del contenedor que se vacía:** Monta un único buscador con *debounce* (120 ms), botón **Solo ON** (filtra módulos activos), y botones **`+` / `−`** para expandir o colapsar todas las secciones en un toque, sin perder el foco ni cerrar el teclado de Android.
- **Escudo CSS anti-rotura en `.mes_text`:** Fuerza `overflow: hidden !important; isolation: isolate !important;` en `.mes_text` y `position: static !important; max-width: 100% !important; overflow-wrap: break-word !important;` en `.mes_text *`, neutralizando coordenadas, `transform` y márgenes negativos inline.

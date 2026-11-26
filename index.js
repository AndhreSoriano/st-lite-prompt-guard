/**
 * Lite Prompt Guard (Mobile) v1.6.0
 *
 * Optimizador ultraligero para SillyTavern + NemoEngine en Termux / Android / Brave:
 * 1. Cero reconstrucción del DOM en #completion_prompt_manager_list (solo clases CSS y ::before/::after).
 * 2. Toggle O(1) (<0.1 ms) y apertura de secciones O(sección): índice en memoria sin re-escanear
 *    los 600+ nodos en cada clic ni mutar el DOM de filas no afectadas.
 * 3. jQuery UI .sortable() + touch-punch desactivados por defecto (botón ⇅ en barra para reordenar
 *    bajo demanda), evitando escaneos Sizzle y cálculos de posición en cada toque.
 * 4. Persistencia inteligente en reposo (coalesced idle save): evita congelamientos por
 *    JSON.stringify + /api/settings/save 1 s después de cada toggle, con volcado inmediato al cerrar
 *    el panel, enviar mensaje, cambiar preset o ocultar/cerrar la pestaña.
 * 5. Aislamiento CSS (contain: layout style paint) y eliminación de drop-shadow/transiciones en iconos.
 * 6. Render Guard: pospone re-renders ocultos y abre #left-nav-panel en 0 ms.
 * 7. Acelerador automático de Regex (pre-filtro literal 40x+ más rápido) y mejoras móviles.
 */

import * as stScript from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { promptManager } from '../../../openai.js';

const { eventSource, event_types, saveSettingsDebounced } = stScript;
const saveSettingsImmediate = typeof stScript.saveSettings === 'function'
    ? () => stScript.saveSettings()
    : () => saveSettingsDebounced();

const EXTENSION_KEY = 'lite_prompt_guard';
const DEFAULT_SETTINGS = Object.freeze({
    sectionsEnabled: true,
    startCollapsed: true,
    deferHiddenRender: true,
    fastToggle: true,
    contentVisibilityEnabled: true,
    gpuLiteEnabled: true,
    lazyImagesEnabled: true,
    autoCollapseReasoning: true,
    cssGuardEnabled: true,
    regexPrefilterEnabled: true,
});

const SEARCH_DEBOUNCE_MS = 120;
const RENDER_DEBOUNCE_MS = 250;
const SMART_SAVE_IDLE_MS = 3500;
const SMART_SAVE_MAX_WAIT_MS = 15000;
const SECTION_DIVIDER_REGEX = /^(=+|⭐─+|━+|─{3,})/;
const SUBHEADER_REGEX = /^<[^>]+>$/;
const HEAVY_NEMO_REGEX_PATTERN = /\b(mental\s*projection|magpie|tracker\s*ui|emoji\s*fx|nemo\s*mp)\b/i;
const CORE_RUNTIME_REGEX_PATTERN = /\b(nemo\s*runtime|nemo\s*story|nemo\s*commands)\b/i;

let cachedRegexEngine = undefined;

/** Caché en memoria de metadatos de cada <li> nativo sin mutar atributos de texto. */
const rowMetaCache = new WeakMap();

/** Instancias de PromptManager ya protegidas por el Render Guard. */
const patchedPromptManagers = new WeakSet();

/** Proveedores y expresiones Regex ya optimizadas con pre-filtro literal. */
const patchedRegexProviders = new WeakSet();
const patchedRegexes = new WeakSet();
const requiredLiteralCache = new Map();

/** Secciones actualmente expandidas en memoria (sobreviven a re-renders nativos). */
const openSections = new Set();

/** Índice estructural en memoria del Prompt Manager para toggles O(1) y secciones O(k). */
let pmIndex = null;
let pmIndexDirty = true;

/** Caché O(1) de prompt_order para evitar búsquedas lineales en cada toggle. */
let cachedOrderArrayRef = null;
let cachedOrderLength = -1;
const promptOrderMap = new Map();

let initializedPresetSections = false;
let onlyActiveFilter = false;
let reorderMode = false;
let origMakeDraggableRef = null;
let deferredStructureDirty = false;
let forceFullRender = false;
let regexSkippedCount = 0;
let lastLowerSrc = '';
let lastLowerVal = '';

let pendingSettingsSave = false;
let smartSaveTimer = null;
let smartSaveIdleId = null;
let smartSaveFirstQueuedAt = 0;

let searchDebounceTimer = null;
let renderDebouncedTimer = null;
let sortableTimer = null;
let visibilityFrameId = null;
let chatMaintenanceFrameId = null;

let containerObserver = null;
let listObserver = null;
let drawerObserver = null;
let chatObserver = null;
let charListObserver = null;
let sectionClickBound = false;
let editSaveBound = false;
let panelActivityBound = false;
let lifecycleFlushBound = false;

/**
 * Inicializa y devuelve la configuración persistente de la extensión.
 */
function getSettings() {
    if (!extension_settings[EXTENSION_KEY] || typeof extension_settings[EXTENSION_KEY] !== 'object') {
        extension_settings[EXTENSION_KEY] = { ...DEFAULT_SETTINGS };
    }
    const settings = extension_settings[EXTENSION_KEY];
    for (const [key, defaultVal] of Object.entries(DEFAULT_SETTINGS)) {
        if (typeof settings[key] !== typeof defaultVal) {
            settings[key] = defaultVal;
        }
    }
    return settings;
}

/**
 * Crea, actualiza o elimina una hoja <style> gestionada por ID.
 * @param {string} id
 * @param {boolean} enabled
 * @param {string} cssText
 */
function syncManagedStyle(id, enabled, cssText) {
    const existing = document.getElementById(id);
    if (!enabled) {
        if (existing) existing.remove();
        return;
    }
    if (existing) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = cssText;
    document.head.appendChild(style);
}

/**
 * Inyecta los estilos base para la barra compacta, secciones colapsables de Nemo y .lpg-hidden.
 */
function injectBaseStyles() {
    syncManagedStyle('lpg-ui-styles', true, `
        /* Ocultamiento puro por CSS: cero eliminación o movimiento de nodos */
        #completion_prompt_manager_list > .completion_prompt_manager_prompt.lpg-hidden {
            display: none !important;
        }

        /* Barra compacta encima de #completion_prompt_manager */
        #lpg-toolbar {
            display: flex;
            align-items: center;
            gap: 4px;
            margin: 6px 0 8px 0;
            width: 100%;
            box-sizing: border-box;
        }

        #lpg-prompt-search {
            flex: 1 1 auto;
            min-width: 0;
            height: 32px;
            padding: 4px 8px;
            font-size: 13px;
            box-sizing: border-box;
        }

        #lpg-search-count {
            flex: 0 0 auto;
            font-size: 11px;
            opacity: 0.78;
            white-space: nowrap;
        }

        #lpg-toolbar .lpg-tool-btn {
            flex: 0 0 auto;
            height: 30px;
            min-width: 26px;
            padding: 0 6px;
            font-size: 11px;
            font-weight: 600;
            line-height: 28px;
            text-align: center;
            cursor: pointer;
            user-select: none;
            -webkit-tap-highlight-color: transparent;
        }

        #lpg-search-clear.lpg-empty {
            display: none;
        }

        #lpg-only-active.lpg-active,
        #lpg-reorder-mode.lpg-active {
            border-color: rgba(76, 175, 80, 0.8);
            background: rgba(76, 175, 80, 0.18);
        }

        /* Aislamiento de layout/paint y cero blur/transiciones pesadas en filas e iconos del Prompt Manager */
        #completion_prompt_manager #completion_prompt_manager_list > li.completion_prompt_manager_prompt:not(.ui-sortable-helper) {
            contain: layout style paint;
        }

        #completion_prompt_manager #completion_prompt_manager_list li.completion_prompt_manager_prompt span span span,
        #completion_prompt_manager .completion_prompt_manager_header_advanced span {
            filter: none !important;
            transition: none !important;
        }

        #completion_prompt_manager,
        #completion_prompt_manager .prompt-manager-toggle-action,
        #completion_prompt_manager .prompt-manager-edit-action,
        #completion_prompt_manager .prompt-manager-detach-action,
        #completion_prompt_manager .prompt-manager-inspect-action,
        #completion_prompt_manager_list > .completion_prompt_manager_prompt.lpg-section {
            touch-action: manipulation;
            -webkit-tap-highlight-color: transparent;
        }

        #completion_prompt_manager #completion_prompt_manager_list li.completion_prompt_manager_prompt .prompt_manager_prompt_controls .prompt-manager-toggle-action {
            min-width: 24px;
            min-height: 24px;
            align-items: center;
            justify-content: center;
        }

        #lpg-toolbar.lpg-no-sections .lpg-sec-btn {
            display: none;
        }

        /* Cabeceras de sección de Nemo (===, ⭐─, ━) sin reconstruir el <li> */
        #completion_prompt_manager_list > .completion_prompt_manager_prompt.lpg-section {
            background: var(--SmartThemeBlurTintColor, rgba(255, 255, 255, 0.06));
            border-left: 3px solid var(--SmartThemeQuoteColor, #7aa2f7);
            border-radius: 4px;
            margin-top: 6px;
            font-weight: 600;
            cursor: pointer;
        }

        #completion_prompt_manager_list > .completion_prompt_manager_prompt.lpg-section .completion_prompt_manager_prompt_name::before {
            content: '▸ ';
            display: inline-block;
            opacity: 0.85;
            margin-right: 3px;
        }

        #completion_prompt_manager_list > .completion_prompt_manager_prompt.lpg-section.lpg-open .completion_prompt_manager_prompt_name::before {
            content: '▾ ';
        }

        #completion_prompt_manager_list > .completion_prompt_manager_prompt.lpg-section[data-lpg-badge]::after {
            content: attr(data-lpg-badge);
            font-size: 10px;
            font-weight: 600;
            opacity: 0.78;
            padding: 1px 5px;
            border-radius: 9px;
            border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.18));
            margin-left: 6px;
            align-self: center;
            white-space: nowrap;
        }

        /* Subcabeceras <Core: ...> de Nemo */
        #completion_prompt_manager_list > .completion_prompt_manager_prompt.lpg-subheader {
            opacity: 0.88;
            font-size: 0.92em;
            border-left: 2px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.25));
            margin-top: 4px;
        }

        #lpg-settings-panel .lpg-group-title {
            font-size: 12px;
            font-weight: 700;
            opacity: 0.85;
            margin: 10px 0 6px 0;
            text-transform: uppercase;
            letter-spacing: 0.03em;
        }

        #lpg-settings-panel .lpg-check-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 6px;
            cursor: pointer;
        }

        #lpg-regex-stats {
            font-size: 12px;
            padding: 6px 8px;
            border-radius: 5px;
            margin-bottom: 8px;
            background: var(--SmartThemeBlurTintColor, rgba(255, 255, 255, 0.05));
            border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.14));
        }

        #lpg-regex-stats.lpg-warn {
            border-color: rgba(255, 152, 0, 0.7);
            background: rgba(255, 152, 0, 0.12);
        }

        #lpg-settings-panel .lpg-btn-stack {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-bottom: 8px;
        }

        #lpg-settings-panel .lpg-action-btn {
            width: 100%;
            text-align: center;
            padding: 6px 10px;
            font-size: 12px;
            cursor: pointer;
        }
    `);
}

/**
 * Evita pintar y calcular layout de mensajes y tarjetas de personajes fuera de pantalla.
 */
function syncContentVisibility() {
    syncManagedStyle('lpg-cv-styles', getSettings().contentVisibilityEnabled, `
        #chat > .mes {
            content-visibility: auto;
            contain-intrinsic-size: auto 220px;
        }

        #rm_print_characters_block .character_select {
            content-visibility: auto;
            contain-intrinsic-size: auto 72px;
        }
    `);
}

/**
 * Desactiva efectos pesados de GPU móvil (backdrop-filter blur, sombras y transiciones UI).
 */
function syncGpuLite() {
    syncManagedStyle('lpg-gpu-lite-styles', getSettings().gpuLiteEnabled, `
        #top-settings-holder,
        .drawer-content,
        #sheld,
        #form_sheld,
        #send_form,
        .mes,
        .popup,
        .shadow_popup,
        .dialogue_popup,
        .inline-drawer-content {
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
            box-shadow: none !important;
            transition: none !important;
        }

        .drawer-content,
        .mes {
            text-shadow: none !important;
        }
    `);
}

/**
 * Activa o desactiva la hoja CSS anti-rotura dentro de .mes_text para pantallas móviles.
 */
function syncChatCssGuard() {
    syncManagedStyle('lpg-chat-css-guard', getSettings().cssGuardEnabled, `
        /* Contención del flujo de mensaje para evitar solapamiento sobre avatares o mensajes previos */
        .mes_text {
            position: relative !important;
            overflow: hidden !important;
            isolation: isolate !important;
            max-width: 100% !important;
            overflow-wrap: break-word !important;
            word-break: break-word !important;
        }

        /* Neutraliza position: absolute/fixed, z-index invasivos y desbordamientos en hijos */
        .mes_text * {
            position: static !important;
            max-width: 100% !important;
            overflow-wrap: break-word !important;
            word-wrap: break-word !important;
            box-sizing: border-box !important;
            z-index: auto !important;
        }

        /* Anula coordenadas, transforms y márgenes negativos inline sin romper márgenes normales */
        .mes_text [style*="transform"] {
            transform: none !important;
        }

        .mes_text [style*="top:"],
        .mes_text [style*="left:"],
        .mes_text [style*="right:"],
        .mes_text [style*="bottom:"],
        .mes_text [style*="inset"] {
            top: auto !important;
            left: auto !important;
            right: auto !important;
            bottom: auto !important;
            inset: auto !important;
        }

        .mes_text [style*="margin"][style*="-"] {
            margin: 0 !important;
        }

        /* Multimedia, bloques de código y tablas seguros en pantallas estrechas */
        .mes_text img,
        .mes_text video,
        .mes_text iframe,
        .mes_text svg {
            max-width: 100% !important;
            height: auto !important;
        }

        .mes_text pre,
        .mes_text code {
            max-width: 100% !important;
            white-space: pre-wrap !important;
            overflow-wrap: anywhere !important;
        }

        .mes_text table {
            display: block !important;
            max-width: 100% !important;
            overflow-x: auto !important;
        }
    `);
}

/**
 * Indica si el panel izquierdo de configuración de IA / Prompt Manager está abierto.
 * @returns {boolean}
 */
function isAiConfigPanelOpen() {
    const panel = document.getElementById('left-nav-panel');
    if (!panel) return true;
    return panel.classList.contains('openDrawer') && !panel.classList.contains('closedDrawer');
}

/**
 * Comprueba si #completion_prompt_manager_list ya tiene filas renderizadas.
 * @returns {boolean}
 */
function hasRenderedPromptItems() {
    return Boolean(document.querySelector('#completion_prompt_manager_list > .completion_prompt_manager_prompt'));
}

/**
 * Vuelca los cambios pendientes en settings.json si existe un guardado diferido.
 * @param {boolean} immediate
 */
function flushPendingSettingsSave(immediate = true) {
    if (smartSaveTimer !== null) {
        clearTimeout(smartSaveTimer);
        smartSaveTimer = null;
    }
    if (smartSaveIdleId !== null && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(smartSaveIdleId);
        smartSaveIdleId = null;
    }
    if (!pendingSettingsSave) return;

    pendingSettingsSave = false;
    smartSaveFirstQueuedAt = 0;

    if (immediate) {
        saveSettingsImmediate();
    } else {
        saveSettingsImmediate();
    }
}

/**
 * Programa el guardado de ajustes tras una pausa de inactividad (evita JSON.stringify + I/O
 * en medio de toques rápidos o scroll dentro del panel).
 */
function scheduleSmartSettingsSave() {
    pendingSettingsSave = true;
    const now = performance.now();
    if (smartSaveFirstQueuedAt === 0) {
        smartSaveFirstQueuedAt = now;
    }

    if (smartSaveTimer !== null) {
        clearTimeout(smartSaveTimer);
        smartSaveTimer = null;
    }
    if (smartSaveIdleId !== null && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(smartSaveIdleId);
        smartSaveIdleId = null;
    }

    const elapsed = now - smartSaveFirstQueuedAt;
    const runIdleFlush = () => {
        if (!pendingSettingsSave) return;
        if (typeof requestIdleCallback === 'function') {
            smartSaveIdleId = requestIdleCallback(() => {
                smartSaveIdleId = null;
                flushPendingSettingsSave(false);
            }, { timeout: 2000 });
        } else {
            smartSaveIdleId = setTimeout(() => {
                smartSaveIdleId = null;
                flushPendingSettingsSave(false);
            }, 0);
        }
    };

    if (elapsed >= SMART_SAVE_MAX_WAIT_MS) {
        runIdleFlush();
        return;
    }

    const waitMs = Math.min(SMART_SAVE_IDLE_MS, SMART_SAVE_MAX_WAIT_MS - elapsed);
    smartSaveTimer = setTimeout(() => {
        smartSaveTimer = null;
        runIdleFlush();
    }, waitMs);
}

/**
 * Retrasa brevemente el guardado pendiente mientras el usuario sigue tocando o haciendo scroll.
 */
function notePanelInteraction() {
    if (!pendingSettingsSave) return;
    if (performance.now() - smartSaveFirstQueuedAt >= SMART_SAVE_MAX_WAIT_MS) return;
    scheduleSmartSettingsSave();
}

/**
 * Registra listeners pasivos en #left-nav-panel para no guardar justo durante el scroll/toque.
 */
function bindPanelInteractionTracker() {
    if (panelActivityBound) return;
    const panel = document.getElementById('left-nav-panel');
    if (!panel) return;

    const opts = { passive: true, capture: true };
    panel.addEventListener('pointerdown', notePanelInteraction, opts);
    panel.addEventListener('touchmove', notePanelInteraction, opts);
    panel.addEventListener('wheel', notePanelInteraction, opts);
    panel.addEventListener('keydown', notePanelInteraction, opts);
    panelActivityBound = true;
}

/**
 * Garantiza guardado inmediato antes de cerrar pestaña, ocultar app o guardar/exportar presets.
 */
function bindLifecycleSaveFlush() {
    if (lifecycleFlushBound) return;

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flushPendingSettingsSave(true);
        }
    });
    window.addEventListener('pagehide', () => flushPendingSettingsSave(true));
    window.addEventListener('beforeunload', () => flushPendingSettingsSave(true));

    document.addEventListener('click', (event) => {
        if (!pendingSettingsSave) return;
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        if (target.closest('[data-preset-manager-update], [data-preset-manager-new], [data-preset-manager-rename], [data-preset-manager-export], #update_oai_preset')) {
            flushPendingSettingsSave(true);
        }
    }, true);

    lifecycleFlushBound = true;
}

/**
 * Destruye jQuery UI .sortable() y limpia .ui-sortable-handle en #completion_prompt_manager_list
 * para evitar escaneos Sizzle y touch-punch durante el scroll o al pulsar toggles.
 */
function destroySortableIfActive() {
    const listEl = document.getElementById('completion_prompt_manager_list');
    if (!listEl || typeof window.jQuery !== 'function') return;

    const $list = window.jQuery(listEl);
    if ($list.hasClass('ui-sortable') || Boolean($list.data('ui-sortable') || $list.data('sortable'))) {
        try {
            $list.sortable('destroy');
        } catch (_) {
            // Ignorar si ya fue destruido parcialmente
        }
    }

    const leftoverHandles = listEl.querySelectorAll('.ui-sortable-handle');
    for (let i = 0; i < leftoverHandles.length; i++) {
        leftoverHandles[i].classList.remove('ui-sortable-handle');
    }
}

/**
 * Sincroniza el modo de reordenamiento (botón ⇅) con el estado de jQuery UI .sortable().
 */
function syncSortableMode() {
    const reorderBtn = document.getElementById('lpg-reorder-mode');
    if (reorderBtn) {
        reorderBtn.classList.toggle('lpg-active', reorderMode);
        reorderBtn.setAttribute('aria-pressed', String(reorderMode));
    }

    if (!getSettings().fastToggle || reorderMode) {
        if (typeof origMakeDraggableRef === 'function') {
            origMakeDraggableRef();
            if (reorderMode && typeof window.jQuery === 'function') {
                const $list = window.jQuery('#completion_prompt_manager_list');
                if ($list.data('ui-sortable') || $list.data('sortable')) {
                    try {
                        $list.sortable('option', 'handle', '.drag-handle');
                    } catch (_) {
                        // Ignorar si aún no está inicializado
                    }
                }
            }
        }
        return;
    }

    if (sortableTimer !== null) {
        clearTimeout(sortableTimer);
        sortableTimer = null;
    }
    destroySortableIfActive();
}

/**
 * Envuelve promptManager.handleToggle si aún no está parcheado (por si init() se ejecuta tarde).
 * @param {object} pm
 */
function wrapPromptManagerHandleToggle(pm) {
    if (!pm || typeof pm.handleToggle !== 'function' || pm.handleToggle.__lpgPatched) return;

    const origHandleToggle = pm.handleToggle.bind(pm);
    const wrappedHandleToggle = function (event) {
        if (getSettings().fastToggle) {
            const target = event?.target instanceof Element ? event.target : null;
            const toggleEl = target?.closest('.prompt-manager-toggle-action');
            if (toggleEl && handleInstantToggle(toggleEl, event)) {
                return;
            }
        }
        return origHandleToggle(event);
    };
    wrappedHandleToggle.__lpgPatched = true;
    pm.handleToggle = wrappedHandleToggle;
}

/**
 * Protege la instancia de PromptManager contra re-renders costosos al borrar/editar/recibir
 * mensajes, desactiva sortable() salvo en modo ⇅, y omite tryGenerate() cuando fastToggle está activo.
 */
function patchPromptManager() {
    if (!promptManager) return;

    wrapPromptManagerHandleToggle(promptManager);
    if (patchedPromptManagers.has(promptManager)) {
        syncSortableMode();
        return;
    }

    const origRender = promptManager.render.bind(promptManager);
    if (typeof promptManager.makeDraggable === 'function') {
        origMakeDraggableRef = promptManager.makeDraggable.bind(promptManager);
    }

    promptManager.render = function (afterTryGenerate = true) {
        const settings = getSettings();

        if (!forceFullRender && settings.deferHiddenRender && !isAiConfigPanelOpen()) {
            if (!hasRenderedPromptItems()) {
                deferredStructureDirty = true;
            }
            return;
        }

        deferredStructureDirty = false;
        const effectiveDryRun = forceFullRender
            ? true
            : (settings.fastToggle ? false : afterTryGenerate);

        return origRender(effectiveDryRun);
    };

    promptManager.renderDebounced = function () {
        if (renderDebouncedTimer !== null) {
            clearTimeout(renderDebouncedTimer);
        }
        renderDebouncedTimer = setTimeout(() => {
            renderDebouncedTimer = null;
            const settings = getSettings();
            if (settings.deferHiddenRender && !isAiConfigPanelOpen() && hasRenderedPromptItems()) {
                return;
            }
            promptManager.render(true);
        }, RENDER_DEBOUNCE_MS);
    };

    if (origMakeDraggableRef) {
        promptManager.makeDraggable = function () {
            if (!getSettings().fastToggle) {
                return origMakeDraggableRef();
            }
            if (!reorderMode) {
                destroySortableIfActive();
                return;
            }
            if (sortableTimer !== null) {
                clearTimeout(sortableTimer);
            }
            sortableTimer = setTimeout(() => {
                sortableTimer = null;
                if (!reorderMode) {
                    destroySortableIfActive();
                    return;
                }
                origMakeDraggableRef();
                if (typeof window.jQuery === 'function') {
                    const $list = window.jQuery('#completion_prompt_manager_list');
                    if ($list.data('ui-sortable') || $list.data('sortable')) {
                        try {
                            $list.sortable('option', 'handle', '.drag-handle');
                        } catch (_) {
                            // Ignorar
                        }
                    }
                }
            }, 100);
        };
    }

    patchedPromptManagers.add(promptManager);
    syncSortableMode();
}

/**
 * Fuerza un recálculo completo de tokens (tryGenerate) cuando el usuario pulsa ↻.
 */
function forceRecalculateTokens() {
    if (!promptManager) return;
    patchPromptManager();
    forceFullRender = true;
    try {
        promptManager.render(true);
    } finally {
        forceFullRender = false;
    }
}

/**
 * Observa la apertura/cierre de #left-nav-panel: solo renderiza si cambió la estructura,
 * y vuelca cambios pendientes al cerrar el panel.
 */
function observeDrawerOpen() {
    const panel = document.getElementById('left-nav-panel');
    if (!panel) return;

    bindPanelInteractionTracker();

    if (drawerObserver) {
        drawerObserver.disconnect();
        drawerObserver = null;
    }

    drawerObserver = new MutationObserver(() => {
        if (!isAiConfigPanelOpen()) {
            flushPendingSettingsSave(true);
            return;
        }
        if (deferredStructureDirty || !hasRenderedPromptItems()) {
            deferredStructureDirty = false;
            if (promptManager) {
                promptManager.render(!getSettings().fastToggle);
            }
        }
    });
    drawerObserver.observe(panel, { attributes: true, attributeFilter: ['class'] });
}

/**
 * Marca imágenes dentro de un contenedor con carga diferida y decodificación asíncrona.
 * @param {ParentNode} root
 */
function applyLazyImagesIn(root) {
    if (!getSettings().lazyImagesEnabled || !root || !(root instanceof Element || root instanceof Document)) return;
    const imgs = root.querySelectorAll('img');
    for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i];
        if (img.loading !== 'lazy') img.loading = 'lazy';
        if (img.decoding !== 'async') img.decoding = 'async';
    }
}

/**
 * Colapsa bloques <details> de razonamiento/thinking en mensajes anteriores al último.
 */
function collapseOldReasoningBlocks() {
    if (!getSettings().autoCollapseReasoning) return;
    const chat = document.getElementById('chat');
    if (!chat) return;

    const messages = chat.querySelectorAll(':scope > .mes');
    const limit = messages.length - 1;
    for (let i = 0; i < limit; i++) {
        const openDetails = messages[i].querySelectorAll('.mes_reasoning_details[open], .mes_text details[open]');
        for (let j = 0; j < openDetails.length; j++) {
            openDetails[j].removeAttribute('open');
        }
    }
}

/**
 * Programa mantenimiento ligero del chat en un único requestAnimationFrame.
 */
function scheduleChatMaintenance() {
    if (chatMaintenanceFrameId !== null) return;
    chatMaintenanceFrameId = requestAnimationFrame(() => {
        chatMaintenanceFrameId = null;
        collapseOldReasoningBlocks();
        const chat = document.getElementById('chat');
        if (chat) applyLazyImagesIn(chat);
    });
}

/**
 * Observa superficialmente #chat y #rm_print_characters_block (subtree: false).
 */
function observeLazyContainers() {
    const chat = document.getElementById('chat');
    if (chat) {
        if (chatObserver) chatObserver.disconnect();
        chatObserver = new MutationObserver((mutations) => {
            if (getSettings().lazyImagesEnabled) {
                for (const m of mutations) {
                    for (const node of m.addedNodes) {
                        if (node instanceof Element) applyLazyImagesIn(node);
                    }
                }
            }
            if (getSettings().autoCollapseReasoning) {
                scheduleChatMaintenance();
            }
        });
        chatObserver.observe(chat, { childList: true, subtree: false });
        applyLazyImagesIn(chat);
        collapseOldReasoningBlocks();
    }

    const charList = document.getElementById('rm_print_characters_block');
    if (charList) {
        if (charListObserver) charListObserver.disconnect();
        charListObserver = new MutationObserver((mutations) => {
            if (!getSettings().lazyImagesEnabled) return;
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node instanceof Element) applyLazyImagesIn(node);
                }
            }
        });
        charListObserver.observe(charList, { childList: true, subtree: false });
        applyLazyImagesIn(charList);
    }
}

/**
 * Lee y cachea nombre, texto buscable y tipo de fila (sección/subcabecera) para un <li> nativo.
 * @param {HTMLElement} row
 * @param {number} index
 * @returns {{ id: string, searchText: string, isSection: boolean, isSubheader: boolean }}
 */
function getRowMeta(row, index) {
    let cached = rowMetaCache.get(row);
    if (cached !== undefined) return cached;

    const nameEl = row.querySelector('.completion_prompt_manager_prompt_name');
    const rawName = (nameEl?.dataset?.pmName || nameEl?.textContent || '').trim();
    const identifier = (row.dataset?.pmIdentifier || '').trim();
    const isSection = SECTION_DIVIDER_REGEX.test(rawName);
    const isSubheader = !isSection && SUBHEADER_REGEX.test(rawName);

    cached = {
        id: identifier || `lpg-row-${index}`,
        searchText: `${rawName} ${identifier}`.toLowerCase(),
        isSection,
        isSubheader,
    };
    rowMetaCache.set(row, cached);
    return cached;
}

/**
 * Programa el cálculo de secciones y visibilidad en un único requestAnimationFrame.
 */
function scheduleVisibilityUpdate() {
    if (visibilityFrameId !== null) {
        cancelAnimationFrame(visibilityFrameId);
    }
    visibilityFrameId = requestAnimationFrame(() => {
        visibilityFrameId = null;
        applyVisibilityNow();
    });
}

/**
 * Marca el índice estructural en memoria del Prompt Manager como obsoleto.
 */
function invalidatePmIndex() {
    pmIndexDirty = true;
}

/**
 * Construye el índice estructural en memoria de #completion_prompt_manager_list en una sola pasada.
 * @param {HTMLElement} listEl
 * @param {object} settings
 */
function buildPmIndex(listEl, settings) {
    const rows = listEl.querySelectorAll(':scope > .completion_prompt_manager_prompt');
    const entries = new Array(rows.length);
    const byRow = new WeakMap();
    const sections = [];
    const subheaders = [];

    let currentSection = null;
    let currentSubheader = null;
    let totalLeafPrompts = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const meta = getRowMeta(row, i);
        const isEnabled = !row.classList.contains('completion_prompt_manager_prompt_disabled');
        const domSection = row.classList.contains('lpg-section');
        const domSubheader = row.classList.contains('lpg-subheader');
        const domOpen = row.classList.contains('lpg-open');
        const domBadge = row.getAttribute('data-lpg-badge');
        const domHidden = row.classList.contains('lpg-hidden');

        if (meta.isSection && settings.sectionsEnabled) {
            const entry = {
                row,
                meta,
                section: null,
                subheader: null,
                isEnabled,
                isSectionHeader: true,
                isSubheaderRow: false,
                domSection,
                domSubheader,
                domOpen,
                domBadge,
                domHidden,
            };
            currentSection = {
                id: meta.id,
                headerEntry: entry,
                subheaders: [],
                leafEntries: [],
                memberEntries: [],
                total: 0,
                active: 0,
                hasVisibleChild: false,
            };
            entry.section = currentSection;
            sections.push(currentSection);
            currentSubheader = null;
            entries[i] = entry;
            byRow.set(row, entry);
            continue;
        }

        if (meta.isSubheader && settings.sectionsEnabled) {
            const entry = {
                row,
                meta,
                section: currentSection,
                subheader: null,
                isEnabled,
                isSectionHeader: false,
                isSubheaderRow: true,
                domSection,
                domSubheader,
                domOpen,
                domBadge,
                domHidden,
            };
            currentSubheader = {
                entry,
                section: currentSection,
                hasVisibleChild: false,
            };
            entry.subheader = currentSubheader;
            subheaders.push(currentSubheader);
            if (currentSection) {
                currentSection.subheaders.push(currentSubheader);
                currentSection.memberEntries.push(entry);
            }
            entries[i] = entry;
            byRow.set(row, entry);
            continue;
        }

        totalLeafPrompts++;
        if (currentSection) {
            currentSection.total++;
            if (isEnabled) currentSection.active++;
        }

        const entry = {
            row,
            meta,
            section: currentSection,
            subheader: currentSubheader,
            isEnabled,
            isSectionHeader: false,
            isSubheaderRow: false,
            domSection,
            domSubheader,
            domOpen,
            domBadge,
            domHidden,
        };
        if (currentSection) {
            currentSection.leafEntries.push(entry);
            currentSection.memberEntries.push(entry);
        }
        entries[i] = entry;
        byRow.set(row, entry);
    }

    if (!initializedPresetSections && sections.length > 0) {
        if (!settings.startCollapsed) {
            for (let i = 0; i < sections.length; i++) {
                openSections.add(sections[i].id);
            }
        }
        initializedPresetSections = true;
    }

    pmIndex = {
        listEl,
        entries,
        byRow,
        sections,
        subheaders,
        totalLeafPrompts,
    };
    pmIndexDirty = false;
}

/**
 * Agrupa visualmente las secciones de Nemo y aplica los filtros sin mover ni clonar nodos del DOM.
 */
function applyVisibilityNow() {
    const settings = getSettings();
    const toolbar = document.getElementById('lpg-toolbar');
    const input = document.getElementById('lpg-prompt-search');
    const clearBtn = document.getElementById('lpg-search-clear');
    const countEl = document.getElementById('lpg-search-count');
    const activeBtn = document.getElementById('lpg-only-active');
    const listEl = document.getElementById('completion_prompt_manager_list');

    const query = (input?.value || '').trim().toLowerCase();
    const isFiltered = query.length > 0 || onlyActiveFilter;

    if (clearBtn) {
        clearBtn.classList.toggle('lpg-empty', query.length === 0);
    }
    if (activeBtn) {
        activeBtn.classList.toggle('lpg-active', onlyActiveFilter);
        activeBtn.setAttribute('aria-pressed', String(onlyActiveFilter));
    }

    if (!listEl) {
        pmIndex = null;
        pmIndexDirty = true;
        if (countEl) countEl.textContent = '';
        if (toolbar) toolbar.classList.add('lpg-no-sections');
        return;
    }

    if (pmIndexDirty || !pmIndex || pmIndex.listEl !== listEl) {
        buildPmIndex(listEl, settings);
    }

    const { entries, sections, subheaders, totalLeafPrompts } = pmIndex;

    if (toolbar) {
        toolbar.classList.toggle('lpg-no-sections', !settings.sectionsEnabled || sections.length === 0);
    }

    for (let i = 0; i < sections.length; i++) {
        sections[i].hasVisibleChild = false;
    }
    for (let i = 0; i < subheaders.length; i++) {
        subheaders[i].hasVisibleChild = false;
    }

    // Pasada 1 (en memoria): determinar visibilidad de módulos hoja y propagar a cabeceras
    let visibleLeafPrompts = 0;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.isSectionHeader || entry.isSubheaderRow) continue;

        let hide = false;
        if (isFiltered) {
            const matchesActive = !onlyActiveFilter || entry.isEnabled;
            const matchesQuery = query.length === 0 || entry.meta.searchText.includes(query);
            hide = !(matchesActive && matchesQuery);
        } else if (settings.sectionsEnabled && entry.section) {
            hide = !openSections.has(entry.section.id);
        }

        entry.nextHide = hide;
        if (!hide) {
            visibleLeafPrompts++;
            if (entry.section) entry.section.hasVisibleChild = true;
            if (entry.subheader) entry.subheader.hasVisibleChild = true;
        }
    }

    for (let i = 0; i < subheaders.length; i++) {
        const sub = subheaders[i];
        const entry = sub.entry;
        if (isFiltered) {
            const selfMatches = !onlyActiveFilter && query.length > 0 && entry.meta.searchText.includes(query);
            entry.nextHide = !(sub.hasVisibleChild || selfMatches);
        } else if (settings.sectionsEnabled && sub.section) {
            entry.nextHide = !openSections.has(sub.section.id);
        } else {
            entry.nextHide = false;
        }
    }

    for (let i = 0; i < sections.length; i++) {
        const sec = sections[i];
        const entry = sec.headerEntry;
        if (isFiltered) {
            const selfMatches = !onlyActiveFilter && query.length > 0 && entry.meta.searchText.includes(query);
            entry.nextHide = !(sec.hasVisibleChild || selfMatches);
        } else {
            entry.nextHide = false;
        }
    }

    // Pasada 2: aplicar únicamente diferencias respecto al estado cacheado en memoria (0 lecturas DOM)
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const row = entry.row;

        if (entry.domSection !== entry.isSectionHeader) {
            entry.domSection = entry.isSectionHeader;
            row.classList.toggle('lpg-section', entry.isSectionHeader);
        }
        if (entry.domSubheader !== entry.isSubheaderRow) {
            entry.domSubheader = entry.isSubheaderRow;
            row.classList.toggle('lpg-subheader', entry.isSubheaderRow);
        }

        if (entry.isSectionHeader) {
            const isOpen = isFiltered || openSections.has(entry.section.id);
            if (entry.domOpen !== isOpen) {
                entry.domOpen = isOpen;
                row.classList.toggle('lpg-open', isOpen);
            }
            const badge = `${entry.section.active}/${entry.section.total}`;
            if (entry.domBadge !== badge) {
                entry.domBadge = badge;
                row.setAttribute('data-lpg-badge', badge);
            }
        } else {
            if (entry.domOpen) {
                entry.domOpen = false;
                row.classList.remove('lpg-open');
            }
            if (entry.domBadge !== null) {
                entry.domBadge = null;
                row.removeAttribute('data-lpg-badge');
            }
        }

        const hide = entry.nextHide;
        if (entry.domHidden !== hide) {
            entry.domHidden = hide;
            row.classList.toggle('lpg-hidden', hide);
        }
    }

    if (countEl) {
        countEl.textContent = isFiltered ? `${visibleLeafPrompts}/${totalLeafPrompts}` : '';
    }
}

/**
 * Actualiza en O(1) el índice en memoria y el badge de sección tras alternar un único módulo.
 * @param {Element} row
 * @param {boolean} newEnabled
 */
function updateIndexForSingleToggle(row, newEnabled) {
    if (pmIndexDirty || !pmIndex || pmIndex.listEl !== row.parentElement) {
        scheduleVisibilityUpdate();
        return;
    }

    const entry = pmIndex.byRow.get(row);
    if (!entry) {
        scheduleVisibilityUpdate();
        return;
    }

    if (entry.isEnabled === newEnabled) return;
    entry.isEnabled = newEnabled;

    if (!entry.isSectionHeader && !entry.isSubheaderRow && entry.section) {
        entry.section.active += newEnabled ? 1 : -1;
        const headerEntry = entry.section.headerEntry;
        const badge = `${entry.section.active}/${entry.section.total}`;
        if (headerEntry.domBadge !== badge) {
            headerEntry.domBadge = badge;
            headerEntry.row.setAttribute('data-lpg-badge', badge);
        }
    }

    if (onlyActiveFilter) {
        applyVisibilityNow();
    }
}

/**
 * Expande o colapsa únicamente las filas de una sección en O(sección) cuando no hay filtro activo.
 * @param {Element} sectionRow
 */
function toggleSectionByRow(sectionRow) {
    const meta = getRowMeta(sectionRow, 0);
    let nowOpen;
    if (openSections.has(meta.id)) {
        openSections.delete(meta.id);
        nowOpen = false;
    } else {
        openSections.add(meta.id);
        nowOpen = true;
    }

    const query = (document.getElementById('lpg-prompt-search')?.value || '').trim();
    const isFiltered = query.length > 0 || onlyActiveFilter;

    if (!isFiltered && !pmIndexDirty && pmIndex && pmIndex.listEl === sectionRow.parentElement) {
        const headerEntry = pmIndex.byRow.get(sectionRow);
        if (headerEntry?.section) {
            if (headerEntry.domOpen !== nowOpen) {
                headerEntry.domOpen = nowOpen;
                sectionRow.classList.toggle('lpg-open', nowOpen);
            }
            const hide = !nowOpen;
            const members = headerEntry.section.memberEntries;
            for (let i = 0; i < members.length; i++) {
                const m = members[i];
                if (m.domHidden !== hide) {
                    m.domHidden = hide;
                    m.row.classList.toggle('lpg-hidden', hide);
                }
            }
            return;
        }
    }

    scheduleVisibilityUpdate();
}

/**
 * Expande o colapsa todas las secciones detectadas de Nemo en un solo clic.
 * @param {boolean} expand
 */
function setAllSectionsOpen(expand) {
    if (!expand) {
        openSections.clear();
        scheduleVisibilityUpdate();
        return;
    }

    const listEl = document.getElementById('completion_prompt_manager_list');
    if (!listEl) return;

    if (!pmIndexDirty && pmIndex && pmIndex.listEl === listEl) {
        const sections = pmIndex.sections;
        for (let i = 0; i < sections.length; i++) {
            openSections.add(sections[i].id);
        }
    } else {
        const rows = listEl.querySelectorAll(':scope > .completion_prompt_manager_prompt');
        for (let i = 0; i < rows.length; i++) {
            const meta = getRowMeta(rows[i], i);
            if (meta.isSection) {
                openSections.add(meta.id);
            }
        }
    }
    scheduleVisibilityUpdate();
}

/**
 * Monta la barra compacta (buscador + Solo ON + expandir/colapsar + ⇅ + ↻) ANTES de #completion_prompt_manager.
 */
function mountToolbar() {
    if (document.getElementById('lpg-toolbar')) return;

    const pmContainer = document.getElementById('completion_prompt_manager');
    if (!pmContainer || !pmContainer.parentElement) return;

    const toolbar = document.createElement('div');
    toolbar.id = 'lpg-toolbar';
    toolbar.className = 'lpg-no-sections';
    toolbar.innerHTML = `
        <input
            type="text"
            id="lpg-prompt-search"
            class="text_pole"
            placeholder="Buscar módulo..."
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            aria-label="Buscar en Prompt Manager"
        />
        <span id="lpg-search-count" aria-live="polite"></span>
        <button type="button" id="lpg-search-clear" class="menu_button lpg-tool-btn lpg-empty" title="Limpiar búsqueda" aria-label="Limpiar búsqueda">&times;</button>
        <button type="button" id="lpg-only-active" class="menu_button lpg-tool-btn" aria-pressed="false" title="Mostrar solo prompts activos">Solo ON</button>
        <button type="button" id="lpg-expand-all" class="menu_button lpg-tool-btn lpg-sec-btn" title="Expandir todas las secciones" aria-label="Expandir secciones">+</button>
        <button type="button" id="lpg-collapse-all" class="menu_button lpg-tool-btn lpg-sec-btn" title="Colapsar todas las secciones" aria-label="Colapsar secciones">&minus;</button>
        <button type="button" id="lpg-reorder-mode" class="menu_button lpg-tool-btn" aria-pressed="false" title="Activar/desactivar arrastrar para reordenar módulos" aria-label="Reordenar módulos">&#8645;</button>
        <button type="button" id="lpg-recalc-tokens" class="menu_button lpg-tool-btn" title="Recalcular tokens del preset" aria-label="Recalcular tokens">&#8635;</button>
    `;

    pmContainer.parentElement.insertBefore(toolbar, pmContainer);

    const input = toolbar.querySelector('#lpg-prompt-search');
    const clearBtn = toolbar.querySelector('#lpg-search-clear');
    const activeBtn = toolbar.querySelector('#lpg-only-active');
    const expandBtn = toolbar.querySelector('#lpg-expand-all');
    const collapseBtn = toolbar.querySelector('#lpg-collapse-all');
    const reorderBtn = toolbar.querySelector('#lpg-reorder-mode');
    const recalcBtn = toolbar.querySelector('#lpg-recalc-tokens');

    input.addEventListener('input', () => {
        if (searchDebounceTimer !== null) {
            clearTimeout(searchDebounceTimer);
        }
        if (!input.value.trim()) {
            scheduleVisibilityUpdate();
            return;
        }
        searchDebounceTimer = setTimeout(() => {
            searchDebounceTimer = null;
            scheduleVisibilityUpdate();
        }, SEARCH_DEBOUNCE_MS);
    });

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && input.value) {
            event.stopPropagation();
            input.value = '';
            scheduleVisibilityUpdate();
        }
    });

    clearBtn.addEventListener('click', () => {
        input.value = '';
        scheduleVisibilityUpdate();
        input.focus();
    });

    activeBtn.addEventListener('click', () => {
        onlyActiveFilter = !onlyActiveFilter;
        scheduleVisibilityUpdate();
    });

    expandBtn.addEventListener('click', () => setAllSectionsOpen(true));
    collapseBtn.addEventListener('click', () => setAllSectionsOpen(false));
    reorderBtn.addEventListener('click', () => {
        reorderMode = !reorderMode;
        syncSortableMode();
    });
    recalcBtn.addEventListener('click', forceRecalculateTokens);
    syncSortableMode();
}

/**
 * Busca una entrada en prompt_order en O(1) usando un Map cacheado en memoria.
 * @param {object} pm
 * @param {string} promptId
 * @returns {object | null}
 */
function getPromptOrderEntryFast(pm, promptId) {
    const activeChar = pm.activeCharacter
        ?? (pm.configuration?.promptOrder?.strategy === 'global' ? { id: pm.configuration.promptOrder.dummyId } : null);
    if (!activeChar) return null;

    const orderArr = pm.getPromptOrderForCharacter?.(activeChar);
    if (Array.isArray(orderArr)) {
        if (orderArr !== cachedOrderArrayRef || orderArr.length !== cachedOrderLength) {
            promptOrderMap.clear();
            for (let i = 0; i < orderArr.length; i++) {
                const item = orderArr[i];
                if (item && item.identifier) {
                    promptOrderMap.set(item.identifier, item);
                }
            }
            cachedOrderArrayRef = orderArr;
            cachedOrderLength = orderArr.length;
        }
        const found = promptOrderMap.get(promptId);
        if (found) return found;
    }

    return pm.getPromptOrderEntry?.(activeChar, promptId) ?? null;
}

/**
 * Alterna en el acto (in-place, O(1)) un módulo del Prompt Manager sin reconstruir ni re-escanear nodos.
 * @param {Element} toggleEl
 * @param {Event | null} event
 * @returns {boolean} true si se manejó en el acto
 */
function handleInstantToggle(toggleEl, event) {
    if (!getSettings().fastToggle || !promptManager) return false;

    const row = toggleEl.closest('.completion_prompt_manager_prompt');
    const promptId = row?.dataset?.pmIdentifier;
    if (!promptId) return false;

    const entry = getPromptOrderEntryFast(promptManager, promptId);
    if (!entry) return false;

    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();

    const counts = promptManager.tokenHandler?.getCounts?.();
    if (counts && counts[promptId] !== null) {
        counts[promptId] = null;
    }

    const enabled = !entry.enabled;
    entry.enabled = enabled;

    row.classList.toggle('completion_prompt_manager_prompt_disabled', !enabled);
    toggleEl.classList.toggle('fa-toggle-on', enabled);
    toggleEl.classList.toggle('fa-toggle-off', !enabled);

    const tokEl = row.querySelector('.prompt_manager_prompt_tokens');
    if (tokEl && tokEl.dataset.pmTokens !== '-') {
        tokEl.dataset.pmTokens = '-';
        tokEl.textContent = '-';
    }

    updateIndexForSingleToggle(row, enabled);
    scheduleSmartSettingsSave();
    return true;
}

/**
 * Registra un único listener delegado (fase de captura) en #completion_prompt_manager
 * para toggles instantáneos y para abrir/cerrar secciones de Nemo sin abrir el modal nativo.
 */
function bindPromptManagerDelegatedClicks() {
    if (sectionClickBound) return;

    const pmContainer = document.getElementById('completion_prompt_manager');
    if (!pmContainer) return;

    pmContainer.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        const toggleEl = target.closest('.prompt-manager-toggle-action');
        if (toggleEl && handleInstantToggle(toggleEl, event)) {
            return;
        }

        if (!getSettings().sectionsEnabled) return;

        const sectionRow = target.closest('.completion_prompt_manager_prompt.lpg-section');
        if (!sectionRow) return;

        if (target.closest('.prompt_manager_prompt_controls, .drag-handle')) return;

        event.preventDefault();
        event.stopPropagation();

        toggleSectionByRow(sectionRow);
    }, true);

    sectionClickBound = true;
}

/**
 * Guarda cambios de edición de un prompt existente en el acto sin reconstruir toda la lista.
 */
function bindInstantEditSave() {
    if (editSaveBound) return;

    const saveBtn = document.getElementById('completion_prompt_manager_popup_entry_form_save');
    if (!saveBtn) return;

    saveBtn.addEventListener('click', (event) => {
        if (!getSettings().fastToggle || !promptManager) return;

        const promptId = saveBtn.dataset?.pmPrompt;
        if (!promptId) return;

        const prompt = promptManager.getPromptById?.(promptId);
        if (!prompt) return; // Creación de prompt nuevo -> dejar flujo nativo

        event.preventDefault();
        event.stopPropagation();

        promptManager.updatePromptWithPromptEditForm?.(prompt);

        if (document.getElementById(`${promptId}_prompt`) && typeof promptManager.updateQuickEdit === 'function') {
            promptManager.updateQuickEdit(promptId, prompt);
        }

        promptManager.hidePopup?.();
        promptManager.clearEditForm?.();

        const listEl = document.getElementById('completion_prompt_manager_list');
        if (listEl) {
            const rows = listEl.querySelectorAll(':scope > .completion_prompt_manager_prompt');
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (row.dataset?.pmIdentifier !== promptId) continue;

                const nameWrap = row.querySelector('.completion_prompt_manager_prompt_name');
                if (nameWrap) {
                    const newName = prompt.name || '';
                    nameWrap.dataset.pmName = newName;
                    const titleEl = nameWrap.querySelector('.prompt-manager-inspect-action, span[title]');
                    if (titleEl) {
                        titleEl.textContent = newName;
                        titleEl.title = newName;
                    }
                }
                rowMetaCache.delete(row);
                break;
            }
        }

        invalidatePmIndex();
        scheduleSmartSettingsSave();
        scheduleVisibilityUpdate();
    }, true);

    editSaveBound = true;
}

/**
 * Conecta un observador superficial (subtree: false) a #completion_prompt_manager_list.
 */
function attachListObserver() {
    if (listObserver) {
        listObserver.disconnect();
        listObserver = null;
    }

    const listEl = document.getElementById('completion_prompt_manager_list');
    if (!listEl) return;

    invalidatePmIndex();
    listObserver = new MutationObserver(() => {
        invalidatePmIndex();
        syncSortableMode();
        scheduleVisibilityUpdate();
    });
    listObserver.observe(listEl, { childList: true, subtree: false });

    syncSortableMode();
    scheduleVisibilityUpdate();
}

/**
 * Observa #completion_prompt_manager de forma superficial para detectar reemplazos de la lista.
 */
function observePromptManager() {
    patchPromptManager();
    bindInstantEditSave();

    const pmContainer = document.getElementById('completion_prompt_manager');
    if (!pmContainer) return;

    bindPromptManagerDelegatedClicks();

    if (containerObserver) {
        containerObserver.disconnect();
        containerObserver = null;
    }

    containerObserver = new MutationObserver(() => {
        invalidatePmIndex();
        patchPromptManager();
        attachListObserver();
    });
    containerObserver.observe(pmContainer, { childList: true, subtree: false });

    attachListObserver();
}

/**
 * Carga de forma segura el motor de Regex integrado en SillyTavern.
 */
async function getRegexEngine() {
    if (cachedRegexEngine !== undefined) return cachedRegexEngine;
    try {
        cachedRegexEngine = await import('../../regex/engine.js');
    } catch (err) {
        console.warn('[Lite Prompt Guard] No se pudo cargar regex/engine.js:', err);
        cachedRegexEngine = null;
    }
    return cachedRegexEngine;
}

/**
 * Determina si un script Regex de Nemo es puramente visual/pesado (Mental Projection, Magpie, Tracker, Emoji FX).
 * Mantiene intactos los scripts esenciales de ejecución (Nemo Runtime, Nemo Story, Nemo Commands).
 * @param {object} script
 * @returns {boolean}
 */
function isHeavyVisualNemoRegex(script) {
    if (!script || typeof script !== 'object') return false;
    const name = String(script.scriptName || '');
    if (HEAVY_NEMO_REGEX_PATTERN.test(name)) return true;
    if (script.markdownOnly && !CORE_RUNTIME_REGEX_PATTERN.test(name) && String(script.findRegex || '').length > 2500) {
        return true;
    }
    return false;
}

/**
 * Extrae una subcadena literal obligatoria (longitud >= 3) de una expresión regular.
 * Solo acepta secuencias sin '|' de nivel superior y grupos obligatorios sin cuantificadores opcionales.
 * @param {string} pattern
 * @returns {string | null}
 */
function extractRequiredLiteral(pattern) {
    if (!pattern || typeof pattern !== 'string') return null;
    const literals = [];

    const hasTopLevelPipe = (src) => {
        let depth = 0;
        let inClass = false;
        for (let i = 0; i < src.length; i++) {
            const ch = src[i];
            if (ch === '\\') { i++; continue; }
            if (inClass) { if (ch === ']') inClass = false; continue; }
            if (ch === '[') { inClass = true; continue; }
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            else if (ch === '|' && depth === 0) return true;
        }
        return false;
    };

    const isOptionalQuantifierAt = (src, idx) => {
        if (idx >= src.length) return false;
        const q = src[idx];
        if (q === '?' || q === '*') return true;
        if (q === '{') return /^\{0[,}]/.test(src.slice(idx));
        return false;
    };

    const skipQuantifier = (src, idx) => {
        if (idx >= src.length) return idx;
        if (src[idx] === '?' || src[idx] === '*' || src[idx] === '+') {
            idx++;
            if (src[idx] === '?') idx++;
            return idx;
        }
        if (src[idx] === '{') {
            const m = src.slice(idx).match(/^\{\d+(?:,\d*)?\}\??/);
            if (m) return idx + m[0].length;
        }
        return idx;
    };

    const scanSequence = (src) => {
        if (!src || hasTopLevelPipe(src)) return;
        let i = 0;
        let currentLit = '';
        const flush = () => {
            if (currentLit.length >= 3) literals.push(currentLit);
            currentLit = '';
        };

        while (i < src.length) {
            const ch = src[i];
            if (ch === '\\') {
                const next = src[i + 1];
                let litChar = null;
                if (next === 'n') litChar = '\n';
                else if (next === 'r') litChar = '\r';
                else if (next === 't') litChar = '\t';
                else if (next === 'f') litChar = '\f';
                else if (next === 'v') litChar = '\v';
                else if (next && /^[^a-zA-Z0-9]$/.test(next)) litChar = next;

                const after = i + 2;
                if (litChar !== null && !isOptionalQuantifierAt(src, after)) {
                    currentLit += litChar;
                    i = skipQuantifier(src, after);
                    if (i !== after) flush();
                } else {
                    flush();
                    i = skipQuantifier(src, after);
                }
                continue;
            }
            if (ch === '[') {
                flush();
                i++;
                while (i < src.length) {
                    if (src[i] === '\\') { i += 2; continue; }
                    if (src[i] === ']') { i++; break; }
                    i++;
                }
                i = skipQuantifier(src, i);
                continue;
            }
            if (ch === '(') {
                flush();
                let depth = 1;
                let j = i + 1;
                let inCls = false;
                while (j < src.length && depth > 0) {
                    if (src[j] === '\\') { j += 2; continue; }
                    if (inCls) { if (src[j] === ']') inCls = false; j++; continue; }
                    if (src[j] === '[') { inCls = true; j++; continue; }
                    if (src[j] === '(') depth++;
                    else if (src[j] === ')') depth--;
                    j++;
                }
                const inner = src.slice(i + 1, j - 1);
                const optional = isOptionalQuantifierAt(src, j);
                const afterQ = skipQuantifier(src, j);
                if (!optional) {
                    if (inner.startsWith('?=')) scanSequence(inner.slice(2));
                    else if (inner.startsWith('?<=')) scanSequence(inner.slice(3));
                    else if (inner.startsWith('?:')) scanSequence(inner.slice(2));
                    else if (inner.startsWith('?<') && !inner.startsWith('?<!')) {
                        const gt = inner.indexOf('>');
                        if (gt !== -1) scanSequence(inner.slice(gt + 1));
                    } else if (!inner.startsWith('?')) {
                        scanSequence(inner);
                    }
                }
                i = afterQ;
                continue;
            }
            if ('.^$*+?{}|'.includes(ch)) {
                flush();
                i = skipQuantifier(src, i + 1);
                continue;
            }
            const after = i + 1;
            if (isOptionalQuantifierAt(src, after)) {
                flush();
                i = skipQuantifier(src, after);
            } else {
                currentLit += ch;
                i = skipQuantifier(src, after);
                if (i !== after) flush();
            }
        }
        flush();
    };

    scanSequence(pattern);
    literals.sort((a, b) => b.length - a.length);
    return literals[0] || null;
}

/**
 * Cachea el último string convertido a minúsculas para pre-filtros case-insensitive.
 * @param {string} str
 * @returns {string}
 */
function getLowerCached(str) {
    if (str === lastLowerSrc) return lastLowerVal;
    lastLowerSrc = str;
    lastLowerVal = str.toLowerCase();
    return lastLowerVal;
}

/**
 * Envuelve RegexProvider.instance.get() para añadir un pre-filtro O(1)/includes()
 * en Regex con literal obligatorio sin desactivar ningún script de Nemo.
 */
async function patchRegexProvider() {
    const engine = await getRegexEngine();
    const provider = engine?.RegexProvider?.instance;
    if (!provider || typeof provider.get !== 'function' || patchedRegexProviders.has(provider)) {
        return;
    }

    const origGet = provider.get.bind(provider);
    const nativeReplace = RegExp.prototype[Symbol.replace];

    provider.get = function (regexString) {
        const regex = origGet(regexString);
        if (!regex || !(regex instanceof RegExp) || patchedRegexes.has(regex)) {
            return regex;
        }

        let requiredLiteral;
        if (requiredLiteralCache.has(regexString)) {
            requiredLiteral = requiredLiteralCache.get(regexString);
        } else {
            requiredLiteral = extractRequiredLiteral(regex.source);
            if (requiredLiteralCache.size >= 1500) {
                requiredLiteralCache.clear();
            }
            requiredLiteralCache.set(regexString, requiredLiteral);
        }

        if (requiredLiteral) {
            const icase = regex.ignoreCase;
            const requiredLower = icase ? requiredLiteral.toLowerCase() : null;

            Object.defineProperty(regex, Symbol.replace, {
                configurable: true,
                writable: true,
                value(target, replaceValue) {
                    if (getSettings().regexPrefilterEnabled && typeof target === 'string') {
                        if (icase) {
                            if (!getLowerCached(target).includes(requiredLower)) {
                                regexSkippedCount++;
                                return target;
                            }
                        } else if (!target.includes(requiredLiteral)) {
                            regexSkippedCount++;
                            return target;
                        }
                    }
                    return nativeReplace.call(this, target, replaceValue);
                },
            });
        }

        patchedRegexes.add(regex);
        return regex;
    };

    patchedRegexProviders.add(provider);
}

/**
 * Actualiza el indicador del optimizador de Regex dentro del panel de Extensiones.
 */
async function refreshRegexStatsUI() {
    const statsEl = document.getElementById('lpg-regex-stats');
    if (!statsEl) return;

    const disableHeavyBtn = document.getElementById('lpg-regex-disable-heavy');
    const disallowAllBtn = document.getElementById('lpg-regex-disallow-all');
    const restoreAllBtn = document.getElementById('lpg-regex-restore-all');

    const engine = await getRegexEngine();
    if (!engine) {
        statsEl.classList.remove('lpg-warn');
        statsEl.textContent = 'Motor Regex no disponible en esta versión de SillyTavern.';
        [disableHeavyBtn, disallowAllBtn, restoreAllBtn].forEach((b) => { if (b) b.disabled = true; });
        return;
    }

    const apiId = engine.getCurrentPresetAPI?.();
    const presetName = engine.getCurrentPresetName?.();
    if (!apiId || !presetName) {
        statsEl.classList.remove('lpg-warn');
        statsEl.textContent = 'Sin preset de Chat Completion activo.';
        return;
    }

    const allowed = Boolean(engine.isPresetScriptsAllowed?.(apiId, presetName));
    const scripts = engine.getScriptsByType?.(engine.SCRIPT_TYPES.PRESET, { allowedOnly: false });
    const list = Array.isArray(scripts) ? scripts : [];
    const total = list.length;
    const enabledCount = list.filter((s) => s && !s.disabled).length;
    const heavyEnabledCount = list.filter((s) => s && !s.disabled && isHeavyVisualNemoRegex(s)).length;

    if (total === 0) {
        statsEl.classList.remove('lpg-warn');
        statsEl.textContent = `Preset "${presetName}": sin scripts Regex integrados.`;
        return;
    }

    if (!allowed) {
        statsEl.classList.remove('lpg-warn');
        statsEl.textContent = `Regex del preset "${presetName}": PAUSADOS (0/${total} activos — máxima velocidad).`;
        return;
    }

    statsEl.classList.toggle('lpg-warn', enabledCount >= 30);
    const skipSuffix = getSettings().regexPrefilterEnabled
        ? ` · Saltos rápidos: ${regexSkippedCount}`
        : '';
    statsEl.textContent = `Preset "${presetName}": ${enabledCount}/${total} Regex activos (${heavyEnabledCount} visuales pesados)${skipSuffix}.`;
}

/**
 * Desactiva únicamente los Regex visuales pesados de Nemo (Mental Projection, Magpie, Tracker, Emoji FX).
 */
async function disableHeavyNemoRegexes() {
    const engine = await getRegexEngine();
    if (!engine) return;

    const scripts = engine.getScriptsByType?.(engine.SCRIPT_TYPES.PRESET, { allowedOnly: false });
    if (!Array.isArray(scripts) || scripts.length === 0) {
        window.toastr?.info('El preset actual no tiene scripts Regex.', 'Lite Prompt Guard');
        return;
    }

    let disabledNow = 0;
    const updated = scripts.map((script) => {
        if (script && !script.disabled && isHeavyVisualNemoRegex(script)) {
            disabledNow++;
            return { ...script, disabled: true };
        }
        return script;
    });

    if (disabledNow > 0) {
        await engine.saveScriptsByType(updated, engine.SCRIPT_TYPES.PRESET);
    }

    await refreshRegexStatsUI();
    window.toastr?.success(
        disabledNow > 0
            ? `Se desactivaron ${disabledNow} Regex visuales pesados de Nemo (Runtime/Story intactos).`
            : 'Los Regex visuales pesados ya estaban desactivados.',
        'Lite Prompt Guard',
    );
}

/**
 * Pausa todos los Regex del preset actual al instante sin modificar el archivo JSON del preset.
 */
async function disallowAllPresetRegexes() {
    const engine = await getRegexEngine();
    if (!engine) return;

    const apiId = engine.getCurrentPresetAPI?.();
    const presetName = engine.getCurrentPresetName?.();
    if (!apiId || !presetName) return;

    engine.disallowPresetScripts(apiId, presetName);
    await refreshRegexStatsUI();
    window.toastr?.info(`Regex del preset "${presetName}" pausados.`, 'Lite Prompt Guard');
}

/**
 * Reactiva los permisos del preset y vuelve a habilitar los Regex visuales de Nemo.
 */
async function restoreAllPresetRegexes() {
    const engine = await getRegexEngine();
    if (!engine) return;

    const apiId = engine.getCurrentPresetAPI?.();
    const presetName = engine.getCurrentPresetName?.();
    if (!apiId || !presetName) return;

    engine.allowPresetScripts(apiId, presetName);

    const scripts = engine.getScriptsByType?.(engine.SCRIPT_TYPES.PRESET, { allowedOnly: false });
    if (Array.isArray(scripts) && scripts.length > 0) {
        let restored = 0;
        const updated = scripts.map((script) => {
            if (script && script.disabled && isHeavyVisualNemoRegex(script)) {
                restored++;
                return { ...script, disabled: false };
            }
            return script;
        });
        if (restored > 0) {
            await engine.saveScriptsByType(updated, engine.SCRIPT_TYPES.PRESET);
        }
    }

    await refreshRegexStatsUI();
    window.toastr?.info(`Regex del preset "${presetName}" restaurados.`, 'Lite Prompt Guard');
}

/**
 * Añade el panel minimalista en Extensiones con los toggles de rendimiento y Nemo.
 */
function mountExtensionSettings() {
    if (document.getElementById('lpg-settings-panel')) return;

    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) return;

    const settings = getSettings();
    const wrapper = document.createElement('div');
    wrapper.id = 'lpg-settings-panel';
    wrapper.className = 'extension_container';
    wrapper.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Lite Prompt Guard (Mobile)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="lpg-group-title">Prompt Manager (Nemo)</div>
                <label class="lpg-check-row" for="lpg-setting-sections">
                    <input type="checkbox" id="lpg-setting-sections" />
                    <span>Agrupar secciones de Nemo (===, ⭐─, ━) colapsables</span>
                </label>
                <label class="lpg-check-row" for="lpg-setting-collapsed">
                    <input type="checkbox" id="lpg-setting-collapsed" />
                    <span>Iniciar con secciones colapsadas (recomendado en Termux)</span>
                </label>
                <label class="lpg-check-row" for="lpg-setting-defer-render">
                    <input type="checkbox" id="lpg-setting-defer-render" />
                    <span>No re-renderizar Prompt Manager si el panel está cerrado (evita lag al borrar/recibir)</span>
                </label>
                <label class="lpg-check-row" for="lpg-setting-fast-toggle">
                    <input type="checkbox" id="lpg-setting-fast-toggle" />
                    <span>Toggle y edición instantáneos sin reconstruir la lista (botón ↻ para tokens)</span>
                </label>

                <div class="lpg-group-title">Chat y rendimiento móvil</div>
                <label class="lpg-check-row" for="lpg-setting-cv">
                    <input type="checkbox" id="lpg-setting-cv" />
                    <span>Virtualización nativa CSS (content-visibility en chat y personajes)</span>
                </label>
                <label class="lpg-check-row" for="lpg-setting-gpu-lite">
                    <input type="checkbox" id="lpg-setting-gpu-lite" />
                    <span>Modo GPU Lite (desactiva blur/sombras/transiciones pesadas)</span>
                </label>
                <label class="lpg-check-row" for="lpg-setting-lazy-img">
                    <input type="checkbox" id="lpg-setting-lazy-img" />
                    <span>Carga diferida de imágenes y avatares (lazy/async)</span>
                </label>
                <label class="lpg-check-row" for="lpg-setting-collapse-reasoning">
                    <input type="checkbox" id="lpg-setting-collapse-reasoning" />
                    <span>Auto-colapsar bloques de razonamiento (thinking) antiguos</span>
                </label>
                <label class="lpg-check-row" for="lpg-setting-css-guard">
                    <input type="checkbox" id="lpg-setting-css-guard" />
                    <span>Escudo CSS anti-rotura en mensajes (.mes_text)</span>
                </label>

                <div class="lpg-group-title">Optimizador de Regex (Nemo)</div>
                <label class="lpg-check-row" for="lpg-setting-regex-prefilter">
                    <input type="checkbox" id="lpg-setting-regex-prefilter" />
                    <span>Acelerador automático de Regex (pre-filtro rápido sin desactivar nada)</span>
                </label>
                <div id="lpg-regex-stats">Analizando Regex del preset...</div>
                <div class="lpg-btn-stack">
                    <button type="button" id="lpg-regex-disable-heavy" class="menu_button lpg-action-btn">
                        Quitar Regex pesados de Nemo (Mental Projection / Magpie / Tracker)
                    </button>
                    <button type="button" id="lpg-regex-disallow-all" class="menu_button lpg-action-btn">
                        Pausar TODOS los Regex del preset (máxima velocidad)
                    </button>
                    <button type="button" id="lpg-regex-restore-all" class="menu_button lpg-action-btn">
                        Restaurar Regex del preset
                    </button>
                </div>
            </div>
        </div>
    `;

    container.appendChild(wrapper);

    wrapper.querySelector('#lpg-regex-disable-heavy')?.addEventListener('click', disableHeavyNemoRegexes);
    wrapper.querySelector('#lpg-regex-disallow-all')?.addEventListener('click', disallowAllPresetRegexes);
    wrapper.querySelector('#lpg-regex-restore-all')?.addEventListener('click', restoreAllPresetRegexes);
    wrapper.querySelector('.inline-drawer-toggle')?.addEventListener('click', refreshRegexStatsUI);
    refreshRegexStatsUI();

    const bindings = [
        ['#lpg-setting-sections', 'sectionsEnabled', () => { invalidatePmIndex(); scheduleVisibilityUpdate(); }],
        ['#lpg-setting-collapsed', 'startCollapsed', (v) => setAllSectionsOpen(!v)],
        ['#lpg-setting-defer-render', 'deferHiddenRender', () => {}],
        ['#lpg-setting-fast-toggle', 'fastToggle', () => syncSortableMode()],
        ['#lpg-setting-cv', 'contentVisibilityEnabled', () => syncContentVisibility()],
        ['#lpg-setting-gpu-lite', 'gpuLiteEnabled', () => syncGpuLite()],
        ['#lpg-setting-lazy-img', 'lazyImagesEnabled', (v) => { if (v) observeLazyContainers(); }],
        ['#lpg-setting-collapse-reasoning', 'autoCollapseReasoning', (v) => { if (v) collapseOldReasoningBlocks(); }],
        ['#lpg-setting-css-guard', 'cssGuardEnabled', () => syncChatCssGuard()],
        ['#lpg-setting-regex-prefilter', 'regexPrefilterEnabled', () => { patchRegexProvider(); refreshRegexStatsUI(); }],
    ];

    for (const [selector, key, onChange] of bindings) {
        const checkbox = wrapper.querySelector(selector);
        checkbox.checked = settings[key];
        checkbox.addEventListener('change', () => {
            settings[key] = checkbox.checked;
            saveSettingsDebounced();
            onChange(checkbox.checked);
        });
    }
}

/**
 * Registra sincronizaciones ligeras con eventos del ciclo de vida de SillyTavern.
 */
function registerSillyTavernEvents() {
    const refresh = () => {
        patchPromptManager();
        patchRegexProvider();
        observeDrawerOpen();
        mountToolbar();
        observePromptManager();
        observeLazyContainers();
        refreshRegexStatsUI();
    };

    const resetPresetSections = () => {
        flushPendingSettingsSave(true);
        if (!isAiConfigPanelOpen()) {
            deferredStructureDirty = true;
        }
        initializedPresetSections = false;
        openSections.clear();
        cachedOrderArrayRef = null;
        cachedOrderLength = -1;
        promptOrderMap.clear();
        invalidatePmIndex();
        refresh();
    };

    if (event_types?.APP_READY) eventSource.on(event_types.APP_READY, refresh);
    if (event_types?.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            flushPendingSettingsSave(true);
            lastLowerSrc = '';
            lastLowerVal = '';
            refresh();
            scheduleChatMaintenance();
        });
    }
    if (event_types?.CHARACTER_SELECTED) eventSource.on(event_types.CHARACTER_SELECTED, refresh);
    if (event_types?.CHARACTER_EDITED) {
        eventSource.on(event_types.CHARACTER_EDITED, () => {
            if (!isAiConfigPanelOpen()) deferredStructureDirty = true;
        });
    }
    if (event_types?.OAI_PRESET_CHANGED_BEFORE) {
        eventSource.on(event_types.OAI_PRESET_CHANGED_BEFORE, () => flushPendingSettingsSave(true));
    }
    if (event_types?.OAI_PRESET_CHANGED_AFTER) eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, resetPresetSections);
    if (event_types?.MAIN_API_CHANGED) eventSource.on(event_types.MAIN_API_CHANGED, resetPresetSections);

    for (const evt of ['GENERATION_STARTED', 'GENERATION_ENDED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_DELETED', 'MESSAGE_EDITED']) {
        if (event_types?.[evt]) {
            eventSource.on(event_types[evt], () => {
                if (evt === 'GENERATION_STARTED' || evt === 'MESSAGE_SENT') {
                    flushPendingSettingsSave(true);
                }
                patchPromptManager();
                patchRegexProvider();
            });
        }
    }

    for (const evt of ['MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_DELETED', 'MESSAGE_SWIPED']) {
        if (event_types?.[evt]) {
            eventSource.on(event_types[evt], scheduleChatMaintenance);
        }
    }
}

jQuery(() => {
    getSettings();
    injectBaseStyles();
    syncContentVisibility();
    syncGpuLite();
    syncChatCssGuard();
    mountExtensionSettings();
    bindLifecycleSaveFlush();
    bindPanelInteractionTracker();
    patchPromptManager();
    patchRegexProvider();
    observeDrawerOpen();
    mountToolbar();
    observePromptManager();
    observeLazyContainers();
    registerSillyTavernEvents();
    setTimeout(() => {
        patchPromptManager();
        patchRegexProvider();
        bindInstantEditSave();
        bindPanelInteractionTracker();
    }, 1500);
});

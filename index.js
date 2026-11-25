/**
 * Lite Prompt Guard (Mobile)
 *
 * Optimizador ultraligero de NemoEngine y Prompt Manager para SillyTavern en Termux / Android / Brave:
 * 1. Cero reconstrucción del DOM en #completion_prompt_manager_list (solo clases CSS y ::before/::after).
 * 2. Secciones colapsables para divisores de Nemo (===, ⭐─, ━) y jerarquía visual para subcabeceras (<...>).
 * 3. Barra compacta persistente (fuera del contenedor que SillyTavern vacía) con buscador con debounce,
 *    filtro "Solo ON" y botones rápidos para expandir/colapsar todas las secciones.
 * 4. Escudo CSS anti-rotura para .mes_text en pantallas móviles estrechas.
 */

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const EXTENSION_KEY = 'lite_prompt_guard';
const DEFAULT_SETTINGS = Object.freeze({
    sectionsEnabled: true,
    startCollapsed: true,
    cssGuardEnabled: true,
});

const SEARCH_DEBOUNCE_MS = 120;
const SECTION_DIVIDER_REGEX = /^(=+|⭐─+|━+|─{3,})/;
const SUBHEADER_REGEX = /^<[^>]+>$/;

/** Caché en memoria de metadatos de cada <li> nativo sin mutar atributos de texto. */
const rowMetaCache = new WeakMap();

/** Secciones actualmente expandidas en memoria (sobreviven a re-renders nativos). */
const openSections = new Set();

let initializedPresetSections = false;
let onlyActiveFilter = false;
let searchDebounceTimer = null;
let visibilityFrameId = null;
let containerObserver = null;
let listObserver = null;
let sectionClickBound = false;

/**
 * Inicializa y devuelve la configuración persistente de la extensión.
 * @returns {{ sectionsEnabled: boolean, startCollapsed: boolean, cssGuardEnabled: boolean }}
 */
function getSettings() {
    if (!extension_settings[EXTENSION_KEY] || typeof extension_settings[EXTENSION_KEY] !== 'object') {
        extension_settings[EXTENSION_KEY] = { ...DEFAULT_SETTINGS };
    }
    const settings = extension_settings[EXTENSION_KEY];
    if (typeof settings.sectionsEnabled !== 'boolean') {
        settings.sectionsEnabled = DEFAULT_SETTINGS.sectionsEnabled;
    }
    if (typeof settings.startCollapsed !== 'boolean') {
        settings.startCollapsed = DEFAULT_SETTINGS.startCollapsed;
    }
    if (typeof settings.cssGuardEnabled !== 'boolean') {
        settings.cssGuardEnabled = DEFAULT_SETTINGS.cssGuardEnabled;
    }
    return settings;
}

/**
 * Inyecta los estilos mínimos para la barra compacta, secciones colapsables de Nemo y .lpg-hidden.
 * Mantiene intacta la estructura <li> nativa de #completion_prompt_manager_list.
 */
function injectBaseStyles() {
    if (document.getElementById('lpg-ui-styles')) return;

    const style = document.createElement('style');
    style.id = 'lpg-ui-styles';
    style.textContent = `
        /* Ocultamiento puro por CSS: cero eliminación o movimiento de nodos */
        #completion_prompt_manager_list > .completion_prompt_manager_prompt.lpg-hidden {
            display: none !important;
        }

        /* Barra compacta encima de #completion_prompt_manager */
        #lpg-toolbar {
            display: flex;
            align-items: center;
            gap: 5px;
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
            min-width: 28px;
            padding: 0 7px;
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

        #lpg-only-active.lpg-active {
            border-color: rgba(76, 175, 80, 0.8);
            background: rgba(76, 175, 80, 0.18);
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

        #lpg-settings-panel .lpg-check-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 6px;
            cursor: pointer;
        }
    `;
    document.head.appendChild(style);
}

/**
 * Activa o desactiva la hoja CSS anti-rotura dentro de .mes_text para pantallas móviles.
 */
function syncChatCssGuard() {
    const { cssGuardEnabled } = getSettings();
    const existing = document.getElementById('lpg-chat-css-guard');

    if (!cssGuardEnabled) {
        if (existing) existing.remove();
        return;
    }

    if (existing) return;

    const guard = document.createElement('style');
    guard.id = 'lpg-chat-css-guard';
    guard.textContent = `
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
    `;
    document.head.appendChild(guard);
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
        if (countEl) countEl.textContent = '';
        if (toolbar) toolbar.classList.add('lpg-no-sections');
        return;
    }

    const rows = listEl.querySelectorAll(':scope > .completion_prompt_manager_prompt');
    const rowInfo = new Array(rows.length);
    const sections = [];
    const subheaders = [];

    let currentSection = null;
    let currentSubheader = null;

    // Pasada 1: clasificar filas y contar módulos activos/totales por sección
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const meta = getRowMeta(row, i);
        const isEnabled = !row.classList.contains('completion_prompt_manager_prompt_disabled');

        if (meta.isSection && settings.sectionsEnabled) {
            currentSection = {
                id: meta.id,
                headerIndex: i,
                row,
                total: 0,
                active: 0,
                hasVisibleChild: false,
            };
            sections.push(currentSection);
            currentSubheader = null;
            rowInfo[i] = { meta, section: currentSection, subheader: null, isEnabled, isSectionHeader: true, isSubheaderRow: false };
            continue;
        }

        if (meta.isSubheader && settings.sectionsEnabled) {
            currentSubheader = {
                index: i,
                row,
                section: currentSection,
                hasVisibleChild: false,
            };
            subheaders.push(currentSubheader);
            rowInfo[i] = { meta, section: currentSection, subheader: currentSubheader, isEnabled, isSectionHeader: false, isSubheaderRow: true };
            continue;
        }

        if (currentSection) {
            currentSection.total++;
            if (isEnabled) currentSection.active++;
        }

        rowInfo[i] = { meta, section: currentSection, subheader: currentSubheader, isEnabled, isSectionHeader: false, isSubheaderRow: false };
    }

    if (toolbar) {
        toolbar.classList.toggle('lpg-no-sections', !settings.sectionsEnabled || sections.length === 0);
    }

    if (!initializedPresetSections && sections.length > 0) {
        if (!settings.startCollapsed) {
            for (const sec of sections) openSections.add(sec.id);
        }
        initializedPresetSections = true;
    }

    // Pasada 2: determinar visibilidad de módulos hoja y propagar a cabeceras cuando hay filtro
    const shouldHide = new Array(rows.length).fill(false);
    let totalLeafPrompts = 0;
    let visibleLeafPrompts = 0;

    for (let i = 0; i < rows.length; i++) {
        const info = rowInfo[i];
        if (info.isSectionHeader || info.isSubheaderRow) continue;

        totalLeafPrompts++;
        let hide = false;

        if (isFiltered) {
            const matchesActive = !onlyActiveFilter || info.isEnabled;
            const matchesQuery = query.length === 0 || info.meta.searchText.includes(query);
            hide = !(matchesActive && matchesQuery);
        } else if (settings.sectionsEnabled && info.section) {
            hide = !openSections.has(info.section.id);
        }

        shouldHide[i] = hide;
        if (!hide) {
            visibleLeafPrompts++;
            if (info.section) info.section.hasVisibleChild = true;
            if (info.subheader) info.subheader.hasVisibleChild = true;
        }
    }

    // Visibilidad de subcabeceras (<...>) y secciones (===)
    for (const sub of subheaders) {
        const info = rowInfo[sub.index];
        if (isFiltered) {
            const selfMatches = !onlyActiveFilter && query.length > 0 && info.meta.searchText.includes(query);
            shouldHide[sub.index] = !(sub.hasVisibleChild || selfMatches);
        } else if (settings.sectionsEnabled && info.section) {
            shouldHide[sub.index] = !openSections.has(info.section.id);
        }
    }

    for (const sec of sections) {
        const info = rowInfo[sec.headerIndex];
        if (isFiltered) {
            const selfMatches = !onlyActiveFilter && query.length > 0 && info.meta.searchText.includes(query);
            shouldHide[sec.headerIndex] = !(sec.hasVisibleChild || selfMatches);
        } else {
            shouldHide[sec.headerIndex] = false;
        }
    }

    // Pasada 3: aplicar únicamente diferencias mínimas de clases/atributos al DOM
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const info = rowInfo[i];

        if (row.classList.contains('lpg-section') !== info.isSectionHeader) {
            row.classList.toggle('lpg-section', info.isSectionHeader);
        }
        if (row.classList.contains('lpg-subheader') !== info.isSubheaderRow) {
            row.classList.toggle('lpg-subheader', info.isSubheaderRow);
        }

        if (info.isSectionHeader) {
            const isOpen = isFiltered || openSections.has(info.section.id);
            if (row.classList.contains('lpg-open') !== isOpen) {
                row.classList.toggle('lpg-open', isOpen);
            }
            const badge = `${info.section.active}/${info.section.total}`;
            if (row.getAttribute('data-lpg-badge') !== badge) {
                row.setAttribute('data-lpg-badge', badge);
            }
        } else {
            if (row.classList.contains('lpg-open')) row.classList.remove('lpg-open');
            if (row.hasAttribute('data-lpg-badge')) row.removeAttribute('data-lpg-badge');
        }

        const hide = shouldHide[i];
        if (row.classList.contains('lpg-hidden') !== hide) {
            row.classList.toggle('lpg-hidden', hide);
        }
    }

    if (countEl) {
        countEl.textContent = isFiltered ? `${visibleLeafPrompts}/${totalLeafPrompts}` : '';
    }
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

    const rows = listEl.querySelectorAll(':scope > .completion_prompt_manager_prompt');
    for (let i = 0; i < rows.length; i++) {
        const meta = getRowMeta(rows[i], i);
        if (meta.isSection) {
            openSections.add(meta.id);
        }
    }
    scheduleVisibilityUpdate();
}

/**
 * Monta la barra compacta (buscador + Solo ON + expandir/colapsar) ANTES de #completion_prompt_manager.
 * Al vivir fuera del contenedor que SillyTavern vacía con innerHTML = '', no pierde el foco ni cierra el teclado.
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
            placeholder="Buscar módulo Nemo..."
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
    `;

    pmContainer.parentElement.insertBefore(toolbar, pmContainer);

    const input = toolbar.querySelector('#lpg-prompt-search');
    const clearBtn = toolbar.querySelector('#lpg-search-clear');
    const activeBtn = toolbar.querySelector('#lpg-only-active');
    const expandBtn = toolbar.querySelector('#lpg-expand-all');
    const collapseBtn = toolbar.querySelector('#lpg-collapse-all');

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
}

/**
 * Registra un único listener delegado (fase de captura) en #completion_prompt_manager
 * para abrir/cerrar secciones de Nemo sin abrir el modal de inspección nativo.
 */
function bindDelegatedSectionClick() {
    if (sectionClickBound) return;

    const pmContainer = document.getElementById('completion_prompt_manager');
    if (!pmContainer) return;

    pmContainer.addEventListener('click', (event) => {
        if (!getSettings().sectionsEnabled) return;

        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        const sectionRow = target.closest('.completion_prompt_manager_prompt.lpg-section');
        if (!sectionRow) return;

        // Respetar controles nativos (toggle, editar, quitar, arrastrar)
        if (target.closest('.prompt_manager_prompt_controls, .drag-handle')) return;

        event.preventDefault();
        event.stopPropagation();

        const meta = getRowMeta(sectionRow, 0);
        if (openSections.has(meta.id)) {
            openSections.delete(meta.id);
        } else {
            openSections.add(meta.id);
        }
        scheduleVisibilityUpdate();
    }, true);

    sectionClickBound = true;
}

/**
 * Conecta un observador superficial (subtree: false) a #completion_prompt_manager_list
 * para re-aplicar secciones y filtros tras cada render nativo de SillyTavern.
 */
function attachListObserver() {
    if (listObserver) {
        listObserver.disconnect();
        listObserver = null;
    }

    const listEl = document.getElementById('completion_prompt_manager_list');
    if (!listEl) return;

    listObserver = new MutationObserver(() => {
        scheduleVisibilityUpdate();
    });
    listObserver.observe(listEl, { childList: true, subtree: false });

    scheduleVisibilityUpdate();
}

/**
 * Observa #completion_prompt_manager de forma superficial para detectar reemplazos de la lista.
 */
function observePromptManager() {
    const pmContainer = document.getElementById('completion_prompt_manager');
    if (!pmContainer) return;

    bindDelegatedSectionClick();

    if (containerObserver) {
        containerObserver.disconnect();
        containerObserver = null;
    }

    containerObserver = new MutationObserver(() => {
        attachListObserver();
    });
    containerObserver.observe(pmContainer, { childList: true, subtree: false });

    attachListObserver();
}

/**
 * Añade un panel minimalista en Extensiones con las opciones de organización y protección móvil.
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
                <label class="lpg-check-row" for="lpg-setting-sections">
                    <input type="checkbox" id="lpg-setting-sections" />
                    <span>Agrupar secciones de Nemo (===, ⭐─, ━) colapsables</span>
                </label>
                <label class="lpg-check-row" for="lpg-setting-collapsed">
                    <input type="checkbox" id="lpg-setting-collapsed" />
                    <span>Iniciar con secciones colapsadas (recomendado en Termux/móvil)</span>
                </label>
                <label class="lpg-check-row" for="lpg-setting-css-guard">
                    <input type="checkbox" id="lpg-setting-css-guard" />
                    <span>Activar escudo CSS anti-rotura en mensajes (.mes_text)</span>
                </label>
            </div>
        </div>
    `;

    container.appendChild(wrapper);

    const sectionsCheckbox = wrapper.querySelector('#lpg-setting-sections');
    const collapsedCheckbox = wrapper.querySelector('#lpg-setting-collapsed');
    const cssCheckbox = wrapper.querySelector('#lpg-setting-css-guard');

    sectionsCheckbox.checked = settings.sectionsEnabled;
    collapsedCheckbox.checked = settings.startCollapsed;
    cssCheckbox.checked = settings.cssGuardEnabled;

    sectionsCheckbox.addEventListener('change', () => {
        settings.sectionsEnabled = sectionsCheckbox.checked;
        saveSettingsDebounced();
        scheduleVisibilityUpdate();
    });

    collapsedCheckbox.addEventListener('change', () => {
        settings.startCollapsed = collapsedCheckbox.checked;
        saveSettingsDebounced();
        setAllSectionsOpen(!settings.startCollapsed);
    });

    cssCheckbox.addEventListener('change', () => {
        settings.cssGuardEnabled = cssCheckbox.checked;
        saveSettingsDebounced();
        syncChatCssGuard();
    });
}

/**
 * Registra sincronizaciones ligeras con eventos del ciclo de vida de SillyTavern.
 */
function registerSillyTavernEvents() {
    const refresh = () => {
        mountToolbar();
        observePromptManager();
    };

    const resetPresetSections = () => {
        initializedPresetSections = false;
        openSections.clear();
        refresh();
    };

    if (event_types?.APP_READY) eventSource.on(event_types.APP_READY, refresh);
    if (event_types?.CHAT_CHANGED) eventSource.on(event_types.CHAT_CHANGED, refresh);
    if (event_types?.CHARACTER_SELECTED) eventSource.on(event_types.CHARACTER_SELECTED, refresh);
    if (event_types?.OAI_PRESET_CHANGED_AFTER) eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, resetPresetSections);
    if (event_types?.MAIN_API_CHANGED) eventSource.on(event_types.MAIN_API_CHANGED, resetPresetSections);
}

jQuery(() => {
    getSettings();
    injectBaseStyles();
    syncChatCssGuard();
    mountExtensionSettings();
    mountToolbar();
    observePromptManager();
    registerSillyTavernEvents();
});

/**
 * Lite Prompt Guard (Mobile)
 *
 * Reemplazo ultraligero de NemoPresetExt optimizado para Android / Brave:
 * 1. Cero reconstrucción del DOM en #completion_prompt_manager_list (solo clase CSS .lpg-hidden).
 * 2. Buscador instantáneo con debounce (120 ms) montado fuera del contenedor que SillyTavern vacía.
 * 3. Botón rápido ON/OFF para Jailbreak / Post-History Instructions usando promptManager.render(false).
 * 4. Escudo CSS anti-rotura para .mes_text que impide desbordamientos y solapamientos en móvil.
 */

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { promptManager } from '../../../openai.js';

const EXTENSION_KEY = 'lite_prompt_guard';
const DEFAULT_SETTINGS = Object.freeze({
    targetPromptName: 'Post-History Instructions',
    cssGuardEnabled: true,
});

const SEARCH_DEBOUNCE_MS = 120;

/** Caché en memoria de nombres normalizados sin mutar atributos del DOM. */
const rowLabelCache = new WeakMap();

let searchDebounceTimer = null;
let filterFrameId = null;
let containerObserver = null;
let listObserver = null;

/**
 * Inicializa y devuelve la configuración persistente de la extensión.
 * @returns {{ targetPromptName: string, cssGuardEnabled: boolean }}
 */
function getSettings() {
    if (!extension_settings[EXTENSION_KEY] || typeof extension_settings[EXTENSION_KEY] !== 'object') {
        extension_settings[EXTENSION_KEY] = { ...DEFAULT_SETTINGS };
    }
    const settings = extension_settings[EXTENSION_KEY];
    if (typeof settings.targetPromptName !== 'string' || !settings.targetPromptName.trim()) {
        settings.targetPromptName = DEFAULT_SETTINGS.targetPromptName;
    }
    if (typeof settings.cssGuardEnabled !== 'boolean') {
        settings.cssGuardEnabled = DEFAULT_SETTINGS.cssGuardEnabled;
    }
    return settings;
}

/**
 * Inyecta los estilos mínimos para el buscador, el botón rápido y la clase oculta.
 * No toca la estructura ni el layout del Prompt Manager nativo.
 */
function injectBaseStyles() {
    if (document.getElementById('lpg-ui-styles')) return;

    const style = document.createElement('style');
    style.id = 'lpg-ui-styles';
    style.textContent = `
        /* Ocultamiento puro por CSS: cero reordenamiento ni eliminación de nodos */
        #completion_prompt_manager_list > .completion_prompt_manager_prompt.lpg-hidden {
            display: none !important;
        }

        /* Buscador compacto en la parte superior del Prompt Manager */
        #lpg-search-wrapper {
            display: flex;
            align-items: center;
            gap: 6px;
            margin: 6px 0 8px 0;
            width: 100%;
            box-sizing: border-box;
        }

        #lpg-prompt-search {
            flex: 1 1 auto;
            min-width: 0;
            height: 32px;
            padding: 4px 10px;
            font-size: 13px;
            box-sizing: border-box;
        }

        #lpg-search-clear {
            flex: 0 0 auto;
            min-width: 28px;
            height: 30px;
            padding: 0 8px;
            line-height: 28px;
            text-align: center;
            cursor: pointer;
            opacity: 0.8;
        }

        #lpg-search-clear.lpg-empty {
            display: none;
        }

        #lpg-search-count {
            flex: 0 0 auto;
            font-size: 11px;
            opacity: 0.75;
            white-space: nowrap;
        }

        /* Botón discreto de acceso rápido en barra superior o área de envío */
        #lpg-jb-holder {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            flex: 0 0 auto;
        }

        #lpg-jb-btn {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            height: 28px;
            padding: 0 8px;
            border-radius: 6px;
            border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.2));
            background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.25));
            color: var(--SmartThemeBodyColor, #eee);
            font-size: 11px;
            font-weight: 600;
            line-height: 1;
            cursor: pointer;
            user-select: none;
            -webkit-tap-highlight-color: transparent;
        }

        #lpg-jb-btn .lpg-jb-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            flex-shrink: 0;
            background: #888;
        }

        #lpg-jb-btn.lpg-on {
            border-color: rgba(76, 175, 80, 0.75);
            background: rgba(76, 175, 80, 0.16);
        }

        #lpg-jb-btn.lpg-on .lpg-jb-dot {
            background: #4caf50;
            box-shadow: 0 0 6px rgba(76, 175, 80, 0.8);
        }

        #lpg-jb-btn.lpg-off {
            border-color: rgba(244, 67, 54, 0.55);
            background: rgba(244, 67, 54, 0.1);
        }

        #lpg-jb-btn.lpg-off .lpg-jb-dot {
            background: #f44336;
        }

        #lpg-jb-btn.lpg-na {
            opacity: 0.45;
        }

        #lpg-settings-panel .lpg-field {
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-bottom: 10px;
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
 * Obtiene y cachea el texto buscable (nombre + identificador) de una fila nativa del Prompt Manager.
 * @param {HTMLElement} row
 * @returns {string}
 */
function getRowSearchText(row) {
    let cached = rowLabelCache.get(row);
    if (cached !== undefined) return cached;

    const nameEl = row.querySelector('.completion_prompt_manager_prompt_name');
    const rawName = nameEl?.dataset?.pmName || nameEl?.textContent || '';
    const identifier = row.dataset?.pmIdentifier || '';
    cached = `${rawName} ${identifier}`.toLowerCase().trim();
    rowLabelCache.set(row, cached);
    return cached;
}

/**
 * Programa el filtrado de prompts en un único requestAnimationFrame para evitar layout thrashing.
 */
function schedulePromptFilter() {
    if (filterFrameId !== null) {
        cancelAnimationFrame(filterFrameId);
    }
    filterFrameId = requestAnimationFrame(() => {
        filterFrameId = null;
        applyPromptFilterNow();
    });
}

/**
 * Filtra las filas nativas existentes aplicando o quitando únicamente la clase .lpg-hidden.
 */
function applyPromptFilterNow() {
    const input = document.getElementById('lpg-prompt-search');
    const clearBtn = document.getElementById('lpg-search-clear');
    const countEl = document.getElementById('lpg-search-count');
    const listEl = document.getElementById('completion_prompt_manager_list');

    const query = (input?.value || '').trim().toLowerCase();

    if (clearBtn) {
        clearBtn.classList.toggle('lpg-empty', query.length === 0);
    }

    if (!listEl) {
        if (countEl) countEl.textContent = '';
        return;
    }

    const rows = listEl.querySelectorAll(':scope > .completion_prompt_manager_prompt');
    let visibleCount = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const shouldHide = query.length > 0 && !getRowSearchText(row).includes(query);
        const isHidden = row.classList.contains('lpg-hidden');

        if (isHidden !== shouldHide) {
            row.classList.toggle('lpg-hidden', shouldHide);
        }
        if (!shouldHide) {
            visibleCount++;
        }
    }

    if (countEl) {
        countEl.textContent = query.length > 0 ? `${visibleCount}/${rows.length}` : '';
    }
}

/**
 * Monta un único <input type="text"> inmediatamente ANTES de #completion_prompt_manager.
 * Montarlo como hermano evita que PromptManager.renderPromptManager() (innerHTML = '') lo destruya
 * o cierre el teclado móvil al pulsar toggles.
 */
function mountPromptSearch() {
    if (document.getElementById('lpg-search-wrapper')) return;

    const pmContainer = document.getElementById('completion_prompt_manager');
    if (!pmContainer || !pmContainer.parentElement) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'lpg-search-wrapper';
    wrapper.innerHTML = `
        <input
            type="text"
            id="lpg-prompt-search"
            class="text_pole"
            placeholder="Filtrar prompts..."
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            aria-label="Filtrar prompts del Prompt Manager"
        />
        <span id="lpg-search-count" aria-live="polite"></span>
        <button type="button" id="lpg-search-clear" class="menu_button lpg-empty" title="Limpiar búsqueda" aria-label="Limpiar búsqueda">&times;</button>
    `;

    pmContainer.parentElement.insertBefore(wrapper, pmContainer);

    const input = wrapper.querySelector('#lpg-prompt-search');
    const clearBtn = wrapper.querySelector('#lpg-search-clear');

    input.addEventListener('input', () => {
        if (searchDebounceTimer !== null) {
            clearTimeout(searchDebounceTimer);
        }
        if (!input.value.trim()) {
            schedulePromptFilter();
            return;
        }
        searchDebounceTimer = setTimeout(() => {
            searchDebounceTimer = null;
            schedulePromptFilter();
        }, SEARCH_DEBOUNCE_MS);
    });

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && input.value) {
            event.stopPropagation();
            input.value = '';
            schedulePromptFilter();
        }
    });

    clearBtn.addEventListener('click', () => {
        input.value = '';
        schedulePromptFilter();
        input.focus();
    });
}

/**
 * Conecta un observador superficial (subtree: false) a #completion_prompt_manager_list
 * para re-aplicar el filtro cuando SillyTavern reconstruya la lista nativa.
 */
function attachListObserver() {
    if (listObserver) {
        listObserver.disconnect();
        listObserver = null;
    }

    const listEl = document.getElementById('completion_prompt_manager_list');
    if (!listEl) return;

    listObserver = new MutationObserver(() => {
        schedulePromptFilter();
        syncQuickToggleUI();
    });
    listObserver.observe(listEl, { childList: true, subtree: false });

    schedulePromptFilter();
}

/**
 * Observa #completion_prompt_manager de forma superficial para detectar reemplazos de la lista.
 */
function observePromptManager() {
    const pmContainer = document.getElementById('completion_prompt_manager');
    if (!pmContainer) return;

    if (containerObserver) {
        containerObserver.disconnect();
        containerObserver = null;
    }

    containerObserver = new MutationObserver(() => {
        attachListObserver();
        syncQuickToggleUI();
    });
    containerObserver.observe(pmContainer, { childList: true, subtree: false });

    attachListObserver();
}

/**
 * Busca el bloque objetivo configurado dentro del PromptManager activo.
 * @returns {{ prompt: object, orderEntry: object } | null}
 */
function findTargetPrompt() {
    if (!promptManager || !promptManager.activeCharacter) return null;
    const prompts = promptManager.serviceSettings?.prompts;
    if (!Array.isArray(prompts) || prompts.length === 0) return null;

    const target = getSettings().targetPromptName.trim().toLowerCase();
    if (!target) return null;

    // 1. Coincidencia exacta por nombre o identificador (solo si está en el orden del personaje)
    for (const prompt of prompts) {
        if (!prompt) continue;
        const name = (prompt.name || '').trim().toLowerCase();
        const id = (prompt.identifier || '').trim().toLowerCase();
        if (name === target || id === target) {
            const orderEntry = promptManager.getPromptOrderEntry(promptManager.activeCharacter, prompt.identifier);
            if (orderEntry) return { prompt, orderEntry };
        }
    }

    // 2. Coincidencia parcial por nombre
    for (const prompt of prompts) {
        if (!prompt) continue;
        const name = (prompt.name || '').trim().toLowerCase();
        if (name.includes(target)) {
            const orderEntry = promptManager.getPromptOrderEntry(promptManager.activeCharacter, prompt.identifier);
            if (orderEntry) return { prompt, orderEntry };
        }
    }

    // 3. Respaldo al identificador nativo 'jailbreak' cuando se busca el bloque estándar
    if (target === 'post-history instructions' || target === 'jailbreak') {
        const jbPrompt = prompts.find((p) => p && p.identifier === 'jailbreak');
        if (jbPrompt) {
            const orderEntry = promptManager.getPromptOrderEntry(promptManager.activeCharacter, jbPrompt.identifier);
            if (orderEntry) return { prompt: jbPrompt, orderEntry };
        }
    }

    return null;
}

/**
 * Actualiza el aspecto visual (ON / OFF / N/A) del botón de acceso rápido.
 */
function syncQuickToggleUI() {
    const btn = document.getElementById('lpg-jb-btn');
    if (!btn) return;

    const labelEl = btn.querySelector('.lpg-jb-label');
    const match = findTargetPrompt();

    btn.classList.remove('lpg-on', 'lpg-off', 'lpg-na');

    if (!match) {
        btn.classList.add('lpg-na');
        btn.setAttribute('aria-pressed', 'false');
        btn.title = `Bloque "${getSettings().targetPromptName}" no disponible en el preset/API actual`;
        if (labelEl) labelEl.textContent = 'JB: N/A';
        return;
    }

    const enabled = Boolean(match.orderEntry.enabled);
    btn.classList.add(enabled ? 'lpg-on' : 'lpg-off');
    btn.setAttribute('aria-pressed', String(enabled));
    btn.title = `${match.prompt.name || match.prompt.identifier}: ${enabled ? 'ACTIVADO' : 'DESACTIVADO'} (clic para alternar)`;
    if (labelEl) labelEl.textContent = enabled ? 'JB: ON' : 'JB: OFF';
}

/**
 * Alterna el bloque objetivo con un clic y evita el dry-run pesado usando render(false).
 */
function toggleTargetPrompt() {
    const match = findTargetPrompt();
    if (!match) {
        if (window.toastr) {
            window.toastr.warning(
                `No se encontró "${getSettings().targetPromptName}" en el preset actual (requiere Chat Completion).`,
                'Lite Prompt Guard',
            );
        }
        syncQuickToggleUI();
        return;
    }

    const { prompt, orderEntry } = match;
    const counts = promptManager.tokenHandler?.getCounts?.();
    if (counts) {
        counts[prompt.identifier] = null;
    }

    orderEntry.enabled = !orderEntry.enabled;

    // render(false) sincroniza la UI del Prompt Manager sin disparar tryGenerate() en móvil
    promptManager.render(false);
    promptManager.saveServiceSettings();

    syncQuickToggleUI();

    if (window.toastr) {
        const stateText = orderEntry.enabled ? 'activado' : 'desactivado';
        window.toastr.info(`${prompt.name || prompt.identifier} ${stateText}.`, 'Lite Prompt Guard', { timeOut: 1500 });
    }
}

/**
 * Monta el botón rápido en la barra superior (#top-settings-holder) o encima del input (#nonQRFormItems).
 */
function mountQuickToggleButton() {
    if (document.getElementById('lpg-jb-btn')) return;

    const topBar = document.getElementById('top-settings-holder');
    const chatTopBar = document.getElementById('nonQRFormItems');
    const anchor = topBar || chatTopBar;
    if (!anchor) return;

    const holder = document.createElement('div');
    holder.id = 'lpg-jb-holder';
    holder.innerHTML = `
        <button type="button" id="lpg-jb-btn" class="lpg-na" aria-pressed="false" title="Alternar Jailbreak">
            <span class="lpg-jb-dot" aria-hidden="true"></span>
            <span class="lpg-jb-label">JB: N/A</span>
        </button>
    `;

    if (topBar) {
        topBar.appendChild(holder);
    } else {
        anchor.prepend(holder);
    }

    holder.querySelector('#lpg-jb-btn').addEventListener('click', toggleTargetPrompt);
    syncQuickToggleUI();
}

/**
 * Añade un panel minimalista en Extensiones para configurar el bloque objetivo y el escudo CSS.
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
                <div class="lpg-field">
                    <label for="lpg-setting-target">Nombre del bloque para el botón rápido:</label>
                    <input type="text" id="lpg-setting-target" class="text_pole" placeholder="Post-History Instructions" />
                </div>
                <label class="checkbox_label" for="lpg-setting-css-guard">
                    <input type="checkbox" id="lpg-setting-css-guard" />
                    <span>Activar escudo CSS anti-rotura en mensajes (.mes_text)</span>
                </label>
            </div>
        </div>
    `;

    container.appendChild(wrapper);

    const targetInput = wrapper.querySelector('#lpg-setting-target');
    const cssCheckbox = wrapper.querySelector('#lpg-setting-css-guard');

    targetInput.value = settings.targetPromptName;
    cssCheckbox.checked = settings.cssGuardEnabled;

    targetInput.addEventListener('input', () => {
        settings.targetPromptName = targetInput.value.trim() || DEFAULT_SETTINGS.targetPromptName;
        saveSettingsDebounced();
        syncQuickToggleUI();
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
        mountPromptSearch();
        mountQuickToggleButton();
        observePromptManager();
        syncQuickToggleUI();
    };

    const eventKeys = [
        'APP_READY',
        'OAI_PRESET_CHANGED_AFTER',
        'CHAT_CHANGED',
        'CHARACTER_SELECTED',
        'MAIN_API_CHANGED',
    ];

    for (const key of eventKeys) {
        if (event_types && event_types[key]) {
            eventSource.on(event_types[key], refresh);
        }
    }
}

jQuery(() => {
    getSettings();
    injectBaseStyles();
    syncChatCssGuard();
    mountExtensionSettings();
    mountPromptSearch();
    mountQuickToggleButton();
    observePromptManager();
    registerSillyTavernEvents();
    syncQuickToggleUI();
});
